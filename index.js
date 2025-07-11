import { MongoClient, ObjectId } from 'mongodb';
import inquirer from 'inquirer';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import AWS from 'aws-sdk';
import colors from 'colors';
import Tesseract from 'tesseract.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import poppler from 'pdf-poppler';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GEMMA_PROMPT_TEMPLATES } from './prompts.js';

const execPromise = promisify(exec);

// Load environment variables from .env file
dotenv.config();
// At the top of the file with other constants:
const API_CALL_DELAY_MS = 5000; // 5 seconds delay between Gemma API calls

let password = process.env.MONGO_PASSWORD;
password = encodeURIComponent(password)

// --- Configuration ---
const MONGODB_URI = `mongodb+srv://${process.env.MONGO_USERNAME}:${password}@cluster0.n1c8q.mongodb.net`

console.log("MONGODB_URI", MONGODB_URI)

const COLLECTION_NAME = 'Invoices';
const PROJECT_ROOT_OUTPUT_DIR = path.join(process.cwd(), 'data');
const METADATA_OUTPUT_FILE = path.join(PROJECT_ROOT_OUTPUT_DIR, 'fetchedDataFile.js');
const DOWNLOADED_FILES_BASE_DIR = path.join(PROJECT_ROOT_OUTPUT_DIR, 'downloaded_files');
const ANALYSIS_RESULTS_FILE = path.join(PROJECT_ROOT_OUTPUT_DIR, 'analysisResults.json');
const TEMP_IMAGE_DIR = path.join(PROJECT_ROOT_OUTPUT_DIR, 'temp_images');

// --- Gemma Configuration ---
const GEMMA_API_KEY = process.env.GEMMA_API_KEY// Replace with your actual key or use process.env
const GEMMA_MODEL_NAME = process.env.GEMMA_MODEL_NAME || "gemma-3-27b-it";

let genAI;
if (GEMMA_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMMA_API_KEY);
} else {
    console.warn("GEMMA_API_KEY not found or is empty. AI analysis will be skipped or will fail.".yellow);
}

// --- AWS S3 Configuration ---
AWS.config.update({
    region: process.env.AWS_REGION || 'us-east-1',
    // Ensure your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set in .env or your AWS credentials file
});
const s3 = new AWS.S3();
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'dentira-private'; // Replace with your actual bucket
const S3_KEY_PREFIX = process.env.S3_KEY_PREFIX || 'invoices/completed/'; // Adjust if needed

// --- Available Options for User ---
const DATABASES = ['dentira', 'canada', 'australia', 'nz'];
const SELECTION_OPTIONS = [
    "PENDING_CONFIRMATION",
    "INV_AMOUNT_VARIANCE",
    "ITEM_UNMATCHED",
    "PO_NOT_FOUND",
    "UNASSIGNED",
    "SHIPTOISSUE"
];

// --- Global MongoDB Client ---
let mongoClient;

async function initializeApp() {
    if (!mongoClient || !mongoClient.topology || !mongoClient.topology.isConnected()) {
        console.log("\nConnecting to MongoDB...".cyan);
        mongoClient = new MongoClient(MONGODB_URI);
        try {
            await mongoClient.connect();
            console.log("Successfully connected to MongoDB for this session.".green);
        } catch (err) {
            console.error("FATAL: Could not connect to MongoDB at startup.".red, err);
            if (err.cause) console.error("Cause:".red, err.cause);
            process.exit(1); // Exit if initial connection fails
        }
    } else {
        console.log("MongoDB connection already established.".blue);
    }
}

async function closeApp() {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) {
        await mongoClient.close();
        console.log("\nMongoDB connection closed. Exiting script.".grey);
    }
}

// --- GEMMA PROMPT TEMPLATES ---
// Add a helper for delay at the top of the file if not already there

async function cleanupPreviousData() {
    console.log('\n--- Cleaning up previous data ---'.yellow);

    // Cleanup metadata file
    try {
        console.log(`[Cleanup] Attempting to unlink: ${METADATA_OUTPUT_FILE}`.grey);
        await fsPromises.unlink(METADATA_OUTPUT_FILE);
        console.log(`[Cleanup] Deleted: ${METADATA_OUTPUT_FILE}`.grey);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`[Cleanup] Metadata file not found, no cleanup needed: ${METADATA_OUTPUT_FILE}`.grey);
        } else {
            console.error(`[Cleanup] Error deleting metadata file ${METADATA_OUTPUT_FILE}:`.red, e);
        }
    }

    // Cleanup analysis results file
    try {
        console.log(`[Cleanup] Attempting to unlink: ${ANALYSIS_RESULTS_FILE}`.grey);
        await fsPromises.unlink(ANALYSIS_RESULTS_FILE);
        console.log(`[Cleanup] Deleted: ${ANALYSIS_RESULTS_FILE}`.grey);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`[Cleanup] Analysis results file not found, no cleanup needed: ${ANALYSIS_RESULTS_FILE}`.grey);
        } else {
            console.error(`[Cleanup] Error deleting analysis results file ${ANALYSIS_RESULTS_FILE}:`.red, e);
        }
    }

    // Cleanup downloaded files directory
    console.log(`[Cleanup] Attempting to remove directory recursively: ${DOWNLOADED_FILES_BASE_DIR}`.magenta);
    try {
        await fsPromises.rm(DOWNLOADED_FILES_BASE_DIR, { recursive: true, force: true });
        // Check if it still exists to confirm deletion
        try {
            await fsPromises.access(DOWNLOADED_FILES_BASE_DIR);
            console.warn(`[Cleanup] WARNING: Directory ${DOWNLOADED_FILES_BASE_DIR} still exists after rm command. Possible permissions issue or locked files.`.yellow.bold);
        } catch (accessError) {
            if (accessError.code === 'ENOENT') {
                console.log(`[Cleanup] Successfully deleted directory: ${DOWNLOADED_FILES_BASE_DIR}`.grey);
            } else {
                console.warn(`[Cleanup] Error checking directory ${DOWNLOADED_FILES_BASE_DIR} status after rm: ${accessError.message}`.yellow);
            }
        }
    } catch (e) {
        // The force:true option should prevent ENOENT from being an error here,
        // but other errors like permission issues would be caught.
        console.error(`[Cleanup] Error during fsPromises.rm for ${DOWNLOADED_FILES_BASE_DIR}:`.red, e);
    }

    // Cleanup temp images directory
    console.log(`[Cleanup] Attempting to remove directory recursively: ${TEMP_IMAGE_DIR}`.magenta);
    try {
        await fsPromises.rm(TEMP_IMAGE_DIR, { recursive: true, force: true });
        try {
            await fsPromises.access(TEMP_IMAGE_DIR);
            console.warn(`[Cleanup] WARNING: Directory ${TEMP_IMAGE_DIR} still exists after rm command.`.yellow.bold);
        } catch (accessError) {
            if (accessError.code === 'ENOENT') {
                console.log(`[Cleanup] Successfully deleted directory: ${TEMP_IMAGE_DIR}`.grey);
            } else {
                console.warn(`[Cleanup] Error checking directory ${TEMP_IMAGE_DIR} status after rm: ${accessError.message}`.yellow);
            }
        }
    } catch (e) {
        console.error(`[Cleanup] Error during fsPromises.rm for ${TEMP_IMAGE_DIR}:`.red, e);
    }
    console.log('--- Cleanup finished ---'.yellow);
}

async function promptUser(questions) {
    if (typeof inquirer.prompt !== 'function') {
        const errorMsg = "CRITICAL: inquirer.prompt is not a function! Check inquirer import/version.";
        console.error(errorMsg.red);
        throw new Error(errorMsg);
    }
    return new Promise((resolve, reject) => {
        inquirer.prompt(questions)
            .then(answers => {
                if (answers === undefined) {
                    console.error('[DEBUG] Inquirer.prompt resolved with undefined! This is unexpected.'.red.bold);
                    resolve({});
                    return;
                }
                resolve(answers);
            })
            .catch(err => {
                console.error('[DEBUG] Inquirer.prompt promise rejected:'.red, err);
                reject(err);
            });
    });
}

async function getUserInputsForCycle() {
    console.log('--- Invoice Data Fetcher ---'.cyan);
    const questions = [
        { type: 'confirm', name: 'clear_previous_data', message: 'Clear previously generated data (metadata, downloads, analysis results)?', default: false, },
        { type: 'list', name: 'database_name', message: 'Select database:', choices: DATABASES, default: 'dentira', },
        { type: 'input', name: 'group_id', message: 'Enter group_id (required):', validate: v => String(v).trim().length ? true : 'Please enter a group_id.', },
        { type: 'checkbox', name: 'selected_options', message: 'Select report options (invoice statuses/issues) to fetch:', choices: SELECTION_OPTIONS, validate: a => a.length < 1 ? 'Choose at least one option.' : true, },
        { type: 'input', name: 'suppliers_input', message: 'Enter supplier(s) (optional, comma-separated):', filter: v => String(v).trim() },
        { type: 'confirm', name: 'delete_after_fetch', message: 'Show DELETE query for fetched invoices (no actual deletion)?', default: false, }
    ];
    return promptUser(questions);
}

async function askForDownloadConfirmation() {
    const { download_files } = await promptUser([{ type: 'confirm', name: 'download_files', message: 'Download actual invoice files for fetched data?', default: false }]);
    return download_files;
}

async function askForAnalysisConfiguration(maxCount) {
    const { perform_analysis } = await promptUser([{ type: 'confirm', name: 'perform_analysis', message: 'Analyze fetched invoice data with AI?', default: false }]);
    if (!perform_analysis) return { perform_analysis: false, include_pdf_content: false, num_to_analyze: 0 };

    const { include_pdf_content } = await promptUser([{ type: 'confirm', name: 'include_pdf_content', message: 'AI analysis to include PDF content (requires PDF download & processing)?', default: true }]);

    if (maxCount === 0) {
        console.log("No files available to select for analysis.".yellow);
        return { perform_analysis: true, include_pdf_content, num_to_analyze: 0 };
    }
    const { num_to_analyze } = await promptUser([{
        type: 'input', name: 'num_to_analyze', message: `How many invoices to analyze? (Enter number or 'all'. Max: ${maxCount}):`, default: 'all',
        validate: v => {
            const valueStr = String(v || '').trim();
            if (valueStr.toLowerCase() === 'all') return true;
            const number = parseInt(valueStr);
            return (!isNaN(number) && number >= 0 && number <= maxCount) ? true : `Enter number between 0-${maxCount} or 'all'.`;
        },
        filter: v => {
            const valueStr = String(v || '').trim();
            return (valueStr.toLowerCase() === 'all') ? maxCount : parseInt(valueStr);
        }
    }]);
    return { perform_analysis: true, include_pdf_content, num_to_analyze };
}

function buildMongoQueries(selectedOptions, suppliers) {
    const queries = {};
    selectedOptions.forEach(option => {
        let queryPart = {};
        switch (option) {
            case "PENDING_CONFIRMATION": queryPart = { status: "PENDING_CONFIRMATION" }; break;
            case "INV_AMOUNT_VARIANCE": queryPart = { "exceptions.header.exception_type": "INV_AMOUNT_VARIANCE", "status": "DISPUTED" }; break;
            case "ITEM_UNMATCHED": queryPart = { "exceptions.line_item.exception_type": "ITEM_UNMATCHED", "status": "DISPUTED" }; break;
            case "PO_NOT_FOUND": queryPart = { "exceptions.header.exception_type": "PO_NOT_FOUND", "status": "DISPUTED" }; break;
            case "UNASSIGNED": queryPart = { "pending_reason": "UNASSIGNED", "status": "PENDING_CONFIRMATION" }; break;
            case "SHIPTOISSUE": queryPart = { "exceptions.header.exception_type": "PO_NOT_FOUND", "status": "DISPUTED", $or: [{ ship_to: { $exists: false } }, { ship_to: "" }, { ship_to: null }] }; break;
            default: console.warn(`Unknown option: ${option}. Skipping.`); return;
        }
        queryPart.file_name = { $regex: /\.pdf$/i };
        if (suppliers && suppliers.length > 0) queryPart.supplier = { $in: suppliers };
        queries[option] = queryPart;
    });
    return queries;
}
async function writeMetadataToFile(dataByOption) {
    try {
        await fsPromises.mkdir(PROJECT_ROOT_OUTPUT_DIR, { recursive: true });
        const fileContent = `// Fetched invoice data at ${new Date().toISOString()}\nexport const fetchedInvoiceReports = ${JSON.stringify(dataByOption, null, 2)};\n`;
        await fsPromises.writeFile(METADATA_OUTPUT_FILE, fileContent);
        console.log(`\nMetadata written to ${METADATA_OUTPUT_FILE}`.green);
    } catch (error) { console.error('Error writing metadata:'.red, error); }
}
async function writeAnalysisResultsToFile(analysisResults) {
    try {
        await fsPromises.mkdir(PROJECT_ROOT_OUTPUT_DIR, { recursive: true });
        const fileContent = JSON.stringify(analysisResults, null, 2);
        await fsPromises.writeFile(ANALYSIS_RESULTS_FILE, fileContent);
        console.log(`\nAI Analysis results written to ${ANALYSIS_RESULTS_FILE}`.green);
    } catch (error) {
        console.error('Error writing AI analysis results:'.red, error);
    }
}
const downloadSingleFileFromS3 = async (s3Key, localDownloadPath) => {
    const fullS3Key = (S3_KEY_PREFIX + s3Key).replace(/\/\//g, '/');
    const params = { Bucket: S3_BUCKET_NAME, Key: fullS3Key };
    console.log(`Downloading: Bucket: ${S3_BUCKET_NAME}, Key: ${fullS3Key}`.yellow);
    await fsPromises.mkdir(path.dirname(localDownloadPath), { recursive: true });
    const fileStream = fs.createWriteStream(localDownloadPath);
    return new Promise((resolve, reject) => {
        s3.getObject(params).createReadStream()
            .on('end', () => { console.log(`Downloaded ${path.basename(localDownloadPath)} to ${localDownloadPath}`.green); resolve(); })
            .on('error', (error) => {
                console.error(`Error downloading ${s3Key} (Key: ${fullS3Key}):`.red, error.message);
                fs.unlink(localDownloadPath, () => { }); reject(error);
            })
            .pipe(fileStream);
    });
};
const downloadInvoiceFiles = async (fetchedDataByOption) => {
    console.log('\n--- Starting Invoice File Downloads ---'.cyan);
    let filesToDownloadList = [];
    for (const reportType in fetchedDataByOption) {
        fetchedDataByOption[reportType].forEach(doc => {
            if (doc.file_name) filesToDownloadList.push(doc);
        });
    }
    if (filesToDownloadList.length === 0) { console.log("No files to download.".yellow); return; }
    console.log(`Total files to potentially download: ${filesToDownloadList.length}`.bgMagenta);
    await fsPromises.mkdir(DOWNLOADED_FILES_BASE_DIR, { recursive: true });
    let downloadedCount = 0, failedCount = 0;
    for (const doc of filesToDownloadList) {
        const localFileName = path.basename(doc.file_name) || doc.original_filename;
        const localDownloadPath = path.join(DOWNLOADED_FILES_BASE_DIR, localFileName);
        try {
            await downloadSingleFileFromS3(doc.file_name, localDownloadPath); downloadedCount++;
        } catch (error) { failedCount++; }
        console.log("-".repeat(60).grey);
    }
    console.log('\n--- Download Summary ---'.cyan.bold);
    console.log(`Successfully downloaded: ${downloadedCount} files.`.green);
    console.log(`Failed to download: ${failedCount} files.`.red);
    console.log(`Files saved in: ${DOWNLOADED_FILES_BASE_DIR}`.blue);
};

// --- Helper function to check if a file is a PDF ---
function isPdf(filePathOrBuffer, originalFileName) {
    if (Buffer.isBuffer(filePathOrBuffer)) {
        if (filePathOrBuffer.length > 4 && filePathOrBuffer.toString('utf8', 0, 5) === '%PDF-') {
            return true;
        }
        return originalFileName && originalFileName.toLowerCase().endsWith('.pdf');
    }
    return filePathOrBuffer && filePathOrBuffer.toLowerCase().endsWith('.pdf');
}

// --- User's Tesseract Function (Integrated) ---
async function extractTextFromPdf(imageBufferOrPath, originalFileNameForPdfCheck, lang = 'eng') {
    console.log(`[Tesseract Wrapper] Starting PDF processing for: ${originalFileNameForPdfCheck || (typeof imageBufferOrPath === 'string' ? path.basename(imageBufferOrPath) : 'buffer')}`.grey);
    let tempPdfPath = null;
    let generatedImageFiles = [];
    let tempImageOutputDir = null;
    const MAX_PAGES_FOR_ANALYSIS = 3;

    try {
        let currentPdfPath = imageBufferOrPath;
        if (Buffer.isBuffer(imageBufferOrPath)) {
            const tempFileName = `temp_pdf_input_${Date.now()}.pdf`;
            tempPdfPath = path.join(os.tmpdir(), tempFileName); // Use os.tmpdir() for system temp
            await fsPromises.writeFile(tempPdfPath, imageBufferOrPath);
            console.log(`[Tesseract Wrapper] Temporary PDF created for processing: ${tempPdfPath}`.grey);
            currentPdfPath = tempPdfPath;
        }

        await fsPromises.access(currentPdfPath);

        // 1. Get page count using pdfinfo
        const pdfInfoCommand = `pdfinfo "${currentPdfPath}"`;
        console.log(`[Tesseract Wrapper] Executing pdfinfo: ${pdfInfoCommand}`.grey);
        const { stdout: pdfInfoOutput, stderr: pdfInfoStderr } = await execPromise(pdfInfoCommand);
        if (pdfInfoStderr) {
            console.warn(`[Tesseract Wrapper] pdfinfo stderr: ${pdfInfoStderr}`.yellow);
        }

        const pagesMatch = pdfInfoOutput.match(/^Pages:\s*(\d+)/m);
        if (!pagesMatch || !pagesMatch[1]) {
            console.warn("[Tesseract Wrapper] Could not determine page count from pdfinfo output. Proceeding with page 1.".yellow);
            // Default to processing page 1 if page count is not determinable, or handle as error
        } else {
            const pageCount = parseInt(pagesMatch[1]);
            console.log(`[Tesseract Wrapper] PDF Page count: ${pageCount}`.blue);

            if (pageCount > MAX_PAGES_FOR_ANALYSIS) {
                const warningMessage = `PDF_TOO_LARGE: Document '${originalFileNameForPdfCheck || path.basename(currentPdfPath)}' has ${pageCount} pages (max ${MAX_PAGES_FOR_ANALYSIS} allowed). Skipping OCR.`;
                console.warn(warningMessage.yellow);
                return warningMessage;
            }
        }

        console.log("[Tesseract Wrapper] PDF page count acceptable or undetermined (processing page 1). Converting page 1 to image via pdftoppm...".blue);
        tempImageOutputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pdftoppm-output-'));
        const outputImagePrefixBase = path.basename(currentPdfPath, '.pdf');
        const outputImagePrefix = path.join(tempImageOutputDir, `page_${outputImagePrefixBase}`);

        const convertCommand = `pdftoppm -png -r 175 -f 1 -l 1 "${currentPdfPath}" "${outputImagePrefix}"`;
        console.log(`[Tesseract Wrapper] Executing: ${convertCommand}`.grey);
        const { stdout: pdftoppmStdout, stderr: pdftoppmStderrPpm } = await execPromise(convertCommand);
        if (pdftoppmStderrPpm) console.warn(`[Tesseract Wrapper] pdftoppm stderr: ${pdftoppmStderrPpm}`.yellow);

        const filesInOutputDir = await fsPromises.readdir(tempImageOutputDir);
        const firstPageImage = filesInOutputDir.find(f => f.startsWith(path.basename(outputImagePrefix)) && f.toLowerCase().endsWith('.png'));

        if (!firstPageImage) {
            throw new Error(`PDF to image conversion failed or no PNG found in ${tempImageOutputDir}. Files: ${filesInOutputDir.join(', ')}`);
        }

        const inputForTesseract = path.join(tempImageOutputDir, firstPageImage);
        generatedImageFiles.push(inputForTesseract); // For cleanup
        console.log(`[Tesseract Wrapper] PDF page 1 converted to: ${inputForTesseract}`.blue);

        const { data: { text } } = await Tesseract.recognize(
            inputForTesseract, 'eng',
            { logger: m => { if (m.status === 'recognizing text') process.stdout.write(`OCR Progress: ${path.basename(originalFileNameForPdfCheck || currentPdfPath)} - ${Math.round(m.progress * 100)}%\r`.yellow); } }
        );
        process.stdout.write('\n');
        console.log("[Tesseract Wrapper] OCR completed.".green);
        return text;

    } catch (error) {
        process.stdout.write('\n');
        console.error("[Tesseract Wrapper] OCR/Conversion Error:".red, error.message || error);
        if (error.stdout) console.error(`[Tesseract Wrapper] CMD stdout on error: ${error.stdout}`.red);
        if (error.stderr) console.error(`[Tesseract Wrapper] CMD stderr on error: ${error.stderr}`.red);
        return null;
    } finally {
        if (tempPdfPath && fs.existsSync(tempPdfPath)) { // Only delete tempPdfPath if it was created by this function
            try { await fsPromises.unlink(tempPdfPath); console.log(`[Tesseract Wrapper] Cleaned temp PDF: ${tempPdfPath}`.grey); }
            catch (e) { console.warn(`[Tesseract Wrapper] Failed to clean temp PDF ${tempPdfPath}: ${e.message}`.yellow); }
        }
        for (const imgPath of generatedImageFiles) {
            if (fs.existsSync(imgPath)) {
                try { await fsPromises.unlink(imgPath); /* console.log(`[Tesseract Wrapper] Cleaned image: ${imgPath}`.grey); */ }
                catch (e) { console.warn(`[Tesseract Wrapper] Failed to clean image ${imgPath}: ${e.message}`.yellow); }
            }
        }
        if (tempImageOutputDir && fs.existsSync(tempImageOutputDir)) {
            try { await fsPromises.rm(tempImageOutputDir, { recursive: true, force: true }); /* console.log(`[Tesseract Wrapper] Cleaned temp dir: ${tempImageOutputDir}`.grey); */ }
            catch (e) { console.warn(`[Tesseract Wrapper] Failed to clean temp dir ${tempImageOutputDir}: ${e.message}`.yellow); }
        }
    }
}

function constructGemmaPrompt(invoiceData, pdfTextIfAvailable, reportType, analysisConfig) {
    const templateInfo = GEMMA_PROMPT_TEMPLATES[reportType];
    let promptText;

    if (!templateInfo) {
        console.warn(`No prompt template for report type: ${reportType}. Using generic fallback.`.yellow);
        promptText = `Analyze this invoice. File: ${invoiceData.file_name || 'N/A'}. JSON Data: ${JSON.stringify(invoiceData)}.`;
        if (pdfTextIfAvailable && analysisConfig.include_pdf_content) {
            promptText += `\n\nPDF Text Content (first 2000 chars):\n${pdfTextIfAvailable.substring(0, 2000)}\n...(truncated if longer)`;
        }
        return promptText;
    }

    promptText = templateInfo.base_prompt;
    promptText = promptText.replace('{file_name}', invoiceData.file_name || 'N/A');
    promptText = promptText.replace('{json_data}', JSON.stringify(invoiceData, null, 2));

    if (templateInfo.criteria) {
        promptText = promptText.replace('{criteria_list}', templateInfo.criteria.join('; '));
    }
    if (promptText.includes('{current_date}')) {
        promptText = promptText.replace('{current_date}', new Date().toISOString().split('T')[0]);
    }
    if (promptText.includes('{exception_diff}')) {
        const varianceException = invoiceData.exceptions?.header?.find(ex => ex.exception_type === "INV_AMOUNT_VARIANCE");
        promptText = promptText.replace('{exception_diff}', varianceException ? String(varianceException.diff) : 'N/A');
    }
    if (promptText.includes('{po_num_value}')) {
        promptText = promptText.replace('{po_num_value}', invoiceData.po_num || 'Not Provided');
    }
    if (promptText.includes('{ship_to_value}')) {
        promptText = promptText.replace('{ship_to_value}', invoiceData.ship_to || 'Not Provided');
    }

    if (pdfTextIfAvailable && analysisConfig.include_pdf_content) {
        if (pdfTextIfAvailable.startsWith("PDF_TOO_LARGE:")) { // Handle specific message
            promptText = promptText.replace('{pdf_content_section}', `\n(Note: ${pdfTextIfAvailable})`);
        } else {
            const pdfTextSection = `\n\nExtracted PDF Text Content (first 3000 chars for context):\nPDF_TEXT_CONTENT_START\n${pdfTextIfAvailable.substring(0, 3000)}\n...(text truncated if longer)...\nPDF_TEXT_CONTENT_END`;
            promptText = promptText.replace('{pdf_content_section}', pdfTextSection);
        }
    } else {
        promptText = promptText.replace('{pdf_content_section}', '\n(User opted out of PDF text content analysis, or PDF text was not available/extraction failed)');
    }

    return promptText;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGemmaApi(promptParts, invoiceFileName, analysisConfig) {
    if (!genAI) {
        const errorMsg = "Gemma SDK (GoogleGenerativeAI) not initialized. Check GEMMA_API_KEY.";
        console.error(errorMsg.red);
        return `Error: ${errorMsg}`;
    }

    console.log(`\nCalling Gemma API for: ${invoiceFileName} using model ${GEMMA_MODEL_NAME}`.blue);

    const MAX_RETRIES = 3;
    let attempts = 0;
    let currentDelay = 60000; // Default 60 seconds for 429, API might provide specific retry-after

    while (attempts < MAX_RETRIES) {
        try {
            const model = genAI.getGenerativeModel({
                model: GEMMA_MODEL_NAME,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                ],
            });

            const result = await model.generateContent(promptParts);
            const response = await result.response;
            const text = response.text();

            console.log(`Gemma raw response for ${invoiceFileName}:`.grey, text.substring(0, 200) + "...");
            return text.trim(); // Success

        } catch (error) {
            attempts++;
            console.error(`Error calling Gemma API for ${invoiceFileName} (Attempt ${attempts}/${MAX_RETRIES}):`.red, error.message);

            // Check for rate limiting error (e.g., 429)
            // The actual error structure might vary based on how @google/genai surfaces HTTP status.
            // For this example, we'll check if error.message contains "429" or "quota".
            // A more robust check would inspect error.status or a specific error code if available from the SDK.
            let isRateLimitError = false;
            let specificRetryDelay = null;

            if (error.message && (error.message.includes("429") || error.message.toLowerCase().includes("quota"))) {
                isRateLimitError = true;
                // Try to parse retryDelay from error message if Google's API provides it like in your example
                const retryDelayMatch = error.message.match(/"retryDelay":"(\d+)s"/);
                if (retryDelayMatch && retryDelayMatch[1]) {
                    specificRetryDelay = parseInt(retryDelayMatch[1], 10) * 1000; // Convert seconds to ms
                    console.log(`API suggests retry_delay of ${specificRetryDelay / 1000}s.`.yellow);
                }
            }

            // Also check for promptFeedback if available (e.g. blocked due to safety)
            if (error.response && error.response.promptFeedback) {
                console.error("Prompt Feedback:".red, error.response.promptFeedback);
                // If it's a safety block, retrying might not help with the same prompt.
                // You might decide not to retry for safety blocks.
                if (error.response.promptFeedback.blockReason) {
                    return `Gemma API call blocked due to safety settings: ${error.response.promptFeedback.blockReason}.`;
                }
            }


            if (isRateLimitError && attempts < MAX_RETRIES) {
                const waitTime = specificRetryDelay || currentDelay;
                console.warn(`Rate limit exceeded for ${invoiceFileName}. Waiting ${waitTime / 1000}s before retry ${attempts + 1}...`.yellow);
                await delay(waitTime);
                currentDelay *= 2; // Exponential backoff for subsequent generic 429s if API doesn't specify
                continue; // Retry the loop
            } else if (attempts >= MAX_RETRIES) {
                console.error(`Max retries reached for ${invoiceFileName}. Giving up.`.red);
                return `Gemma SDK call failed after ${MAX_RETRIES} attempts: ${error.message}.`;
            }
            // For other types of errors, or if max retries reached for non-rate-limit errors
            return `Gemma SDK call failed: ${error.message}.`;
        }
    }
    // Should not be reached if MAX_RETRIES > 0
    return `Gemma SDK call failed exhaustively for ${invoiceFileName}.`;
}

async function analyzeInvoicesWithGemma(invoicesToAnalyze, analysisConfig) {
    console.log(`\n--- Starting AI Analysis for ${invoicesToAnalyze.length} Invoices ---`.cyan.bold);
    const analysisResults = {};

    if (!invoicesToAnalyze || invoicesToAnalyze.length === 0) {
        console.log("No invoices provided to analyze.".yellow);
        return analysisResults;
    }

    for (let i = 0; i < invoicesToAnalyze.length; i++) {
        // Add delay before processing each invoice
        if (i > 0) { // No delay before the very first call
            console.log(`Waiting ${API_CALL_DELAY_MS / 1000}s before next API call...`.gray);
            await delay(API_CALL_DELAY_MS);
        }

        const docToAnalyze = invoicesToAnalyze[i].doc;
        const reportType = invoicesToAnalyze[i].reportType;

        // ... (rest of the function logic remains the same for getting pdfTextContent, promptForGemma) ...
        if (!docToAnalyze || !docToAnalyze.file_name) {
            console.warn(`Skipping analysis for item at index ${i} due to missing document data or file_name.`.yellow);
            analysisResults[docToAnalyze?.file_name || `unknown_file_at_index_${i}`] = {
                report_type: reportType,
                supplier: docToAnalyze?.supplier || 'N/A',
                reason_from_gemma: "Skipped: Missing document data or file_name.",
                suggested_fix_data: null,
                original_data_snippet: { inv_num: docToAnalyze?.inv_num, total: docToAnalyze?.total, /* ... */ }
            };
            continue;
        }

        console.log(`\nAnalyzing invoice ${i + 1}/${invoicesToAnalyze.length}: ${docToAnalyze.file_name} (Report Type: ${reportType})`.blue);

        let pdfTextContent = null;
        let gemmaResponse;
        let analysisReason = "Analysis not performed."; 
        let suggestedFix = null;

        if (analysisConfig.include_pdf_content) {
            const pdfFileName = path.basename(docToAnalyze.file_name) || docToAnalyze.original_filename;
            const pdfPath = path.join(DOWNLOADED_FILES_BASE_DIR, pdfFileName);
            pdfTextContent = await extractTextFromPdf(pdfPath, pdfFileName); 

            if (pdfTextContent && pdfTextContent.startsWith("PDF_TOO_LARGE:")) {
                analysisReason = pdfTextContent;
                gemmaResponse = analysisReason; 
                console.log(`Analysis for ${docToAnalyze.file_name}: ${analysisReason}`.yellow);
            } else if (pdfTextContent === null) {
                analysisReason = "PDF text extraction failed.";
                gemmaResponse = analysisReason;
                console.log(`Analysis for ${docToAnalyze.file_name}: ${analysisReason}`.yellow);
            }
        }

        if (!(analysisReason.startsWith("PDF_TOO_LARGE:") || analysisReason === "PDF text extraction failed.")) {
            const promptForGemma = constructGemmaPrompt(docToAnalyze, pdfTextContent, reportType, analysisConfig);
            gemmaResponse = await callGemmaApi(promptForGemma, docToAnalyze.file_name, analysisConfig); 

            analysisReason = gemmaResponse; 
            const fixDataMarker = "SUGGESTED_FIX_DATA:";
            const markerIndex = (gemmaResponse || "").indexOf(fixDataMarker);

            if (markerIndex !== -1) {
                // ... (rest of the parsing logic for suggested_fix as before)
                analysisReason = gemmaResponse.substring(0, markerIndex).trim();
                const potentialJsonString = gemmaResponse.substring(markerIndex + fixDataMarker.length).trim();
                let jsonStringToParse = potentialJsonString;
                const firstBrace = potentialJsonString.indexOf('{');
                const lastBrace = potentialJsonString.lastIndexOf('}');

                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    jsonStringToParse = potentialJsonString.substring(firstBrace, lastBrace + 1);
                } else {
                    console.warn(`Could not clearly isolate JSON object in SUGGESTED_FIX_DATA for ${docToAnalyze.file_name}. Raw: "${potentialJsonString.substring(0, 100)}..."`.yellow);
                }
                if (jsonStringToParse) {
                    try {
                        suggestedFix = JSON.parse(jsonStringToParse);
                        // console.log(`Parsed suggested fix for ${docToAnalyze.file_name}:`.magenta, suggestedFix); // Already logged if successful
                    } catch (e) {
                        console.warn(`Could not parse SUGGESTED_FIX_DATA JSON for ${docToAnalyze.file_name}. Attempted: "${jsonStringToParse.substring(0, 100)}...". Error:`.yellow, e.message);
                    }
                }
            }
            // console.log(`Gemma analysis reason for ${docToAnalyze.file_name}: ${analysisReason}`.green); // Already logged if successful by callGemmaApi
        }

        analysisResults[docToAnalyze.file_name] = {
            report_type: reportType,
            supplier: docToAnalyze.supplier || 'N/A',
            reason_from_gemma: analysisReason,
            suggested_fix_data: suggestedFix,
            original_data_snippet: {
                inv_num: docToAnalyze.inv_num, total: docToAnalyze.total, inv_date: docToAnalyze.inv_date,
                status: docToAnalyze.status, pending_reason: docToAnalyze.pending_reason,
                group_id: docToAnalyze.group_id
            }
        };
        // Moved detailed logging to after storing, to ensure it's always based on final values
        console.log(`Stored analysis for ${docToAnalyze.file_name}: Reason -> ${analysisResults[docToAnalyze.file_name].reason_from_gemma}`.green);
        if (analysisResults[docToAnalyze.file_name].suggested_fix_data) {
            console.log(`Stored suggested fix for ${docToAnalyze.file_name}:`.cyan, analysisResults[docToAnalyze.file_name].suggested_fix_data);
        }
        console.log("-".repeat(60).grey);
    }

    if (Object.keys(analysisResults).length > 0) {
        await writeAnalysisResultsToFile(analysisResults);
    } else {
        console.log("No analysis results were generated to write.".yellow);
    }
    return analysisResults;
}

async function runAnalysisCycle(client) { // Accepts the global client
    const cycleInputs = await getUserInputsForCycle();
    console.log("cycleInputs && cycleInputs.clear_previous_data_for_cycle ", cycleInputs, "input", cycleInputs.clear_previous_data_for_cycle)
    if (cycleInputs && cycleInputs.clear_previous_data === true) {
        await cleanupPreviousData();
    } else {
        console.log("\nSkipping cleanup for this run.".yellow);
    }

    const {
        database_name, group_id, selected_options, suppliers_input, delete_after_fetch
    } = cycleInputs;

    const suppliers = suppliers_input ? suppliers_input.split(',').map(s => s.trim()).filter(s => s.length > 0) : [];
    const reportQueries = buildMongoQueries(selected_options, suppliers);

    if (Object.keys(reportQueries).length === 0) {
        console.log("No valid report options selected for this run. Skipping cycle.".yellow);
        return;
    }

    let fetchedDataByOption = {};
    let baseQueriesForOptions = {};
    let allFetchedDocumentsForAnalysis = [];

    try {
        console.log(`\nUsing database for this cycle: ${database_name}`.green);
        const db = client.db(database_name); // Use the selected database for this cycle
        const collection = db.collection(COLLECTION_NAME);

        for (const option of selected_options) {
            if (!reportQueries[option]) continue;
            const baseQuery = { group_id: group_id, ...reportQueries[option] };
            baseQueriesForOptions[option] = baseQuery;
            console.log(`\nFetching for "${option}" with query:`.blue, JSON.stringify(baseQuery));
            const documents = await collection.find(baseQuery).toArray();
            fetchedDataByOption[option] = documents;
            documents.forEach(doc => allFetchedDocumentsForAnalysis.push({ doc, reportType: option }));
            console.log(`Found ${documents.length} docs for "${option}".`.magenta);
        }

        if (allFetchedDocumentsForAnalysis.length > 0) {
            await writeMetadataToFile(fetchedDataByOption);

            const proceedWithDownload = await askForDownloadConfirmation();
            if (proceedWithDownload) {
                await downloadInvoiceFiles(fetchedDataByOption);
            } else {
                console.log("\nSkipping file downloads for this run.".yellow);
            }

            const analysisConfig = await askForAnalysisConfiguration(allFetchedDocumentsForAnalysis.length);
            
            if (analysisConfig.perform_analysis && analysisConfig.num_to_analyze > 0) {
                console.log("\n--- AI Analysis Configuration for this run ---".cyan.bold);
                console.log(`Perform AI Analysis: Yes`.green);
                console.log(`Include PDF Content (as text/image): ${analysisConfig.include_pdf_content ? 'Yes' : 'No'}`.blue);
                console.log(`Number of Invoices to Analyze: ${analysisConfig.num_to_analyze}`.blue);
                
                const documentsToActuallyAnalyze = allFetchedDocumentsForAnalysis.slice(0, analysisConfig.num_to_analyze);
                const analysisResults = await analyzeInvoicesWithGemma(documentsToActuallyAnalyze, analysisConfig);

                if (Object.keys(analysisResults).length > 0) {
                    console.log("\n--- Requesting General Fix Suggestions from Gemma (Conceptual) ---".cyan.bold);
                    console.log("Step 8 (Fix suggestions from Gemma based on overall analysis) to be implemented if API is configured.".yellow);
                } else {
                    console.log("AI Analysis completed for this run, but no specific results were generated or stored.".yellow);
                }
            } else {
                console.log("\nSkipping AI analysis for this run based on user input or no files to analyze.".yellow);
            }

            if (delete_after_fetch) { 
                console.log("\n--- MongoDB Deletion Queries (Not Executed) ---".yellow.bold);
                for (const option of selected_options) {
                    const filterForDelete = baseQueriesForOptions[option];
                    if (fetchedDataByOption[option] && fetchedDataByOption[option].length > 0 && filterForDelete) {
                        console.log(`\nQuery to delete for "${option}":`.cyan);
                        console.log(`db.collection('${COLLECTION_NAME}').deleteMany(${JSON.stringify(filterForDelete, null, 2)});`.magenta);
                    } else if (filterForDelete) {
                         console.log(`\nNo docs for "${option}", no deletion query.`.grey);
                    }
                }
            }
        } else {
            console.log("\nNo data fetched for this run. Nothing to write, download, analyze, or show delete query for.".yellow);
        }
    } catch (err) {
        console.error('Error during analysis cycle:'.red, err);
        if (err.cause) console.error('Cause: '.red, err.cause);
        // We don't re-throw here to allow the main loop to ask if user wants to continue
    }
}

// --- Main Application Loop ---
async function mainAppLoop() {
    await initializeApp(); // Connect to MongoDB once at the start

    let keepRunning = true;
    while (keepRunning) {
        try {
            await runAnalysisCycle(mongoClient); // Pass the connected client
        } catch (cycleError) {
            console.error("A critical error occurred in the analysis cycle, trying to continue or exit gracefully:".red.bold, cycleError);
        }

        const prompter = (inquirer.default && inquirer.default.prompt) ? inquirer.default.prompt : inquirer.prompt;
        if (!prompter) {
            console.error("Inquirer not available, cannot ask to continue. Exiting loop.".red);
            keepRunning = false; // Exit if inquirer is broken
        } else {
            try {
                const { continueAnalysis } = await prompter([
                    { type: 'confirm', name: 'continueAnalysis', message: 'Do you want to run another analysis cycle?', default: true }
                ]);
                keepRunning = continueAnalysis;
            } catch (promptError) {
                console.error("Error getting continue confirmation: ".red, promptError);
                keepRunning = false; // Default to exit on prompt error
            }
        }

        if (!keepRunning) {
            console.log("\nExiting analysis application.".blue);
        }
    }

    await closeApp(); // Close MongoDB connection when done
}

// --- Start the application ---
mainAppLoop().catch(error => {
    console.error("Unhandled fatal error in application loop:".red.bold, error);
    if (error.cause) console.error("Cause:".red.bold, error.cause);
    closeApp(); // Attempt to close connection even on unhandled error in the loop itself
});