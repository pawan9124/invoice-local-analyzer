import fs from 'fs/promises';
import path from 'path';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import colors from 'colors';
import { MongoClient, ObjectId } from 'mongodb';

// Load environment variables from .env file
dotenv.config();

// --- Configuration ---
const MONGODB_URI = `mongodb+srv://${process.env.MONGO_USERNAME_WRITEACCESS}:${encodeURIComponent(process.env.MONGO_PASSWORD_WRITEACCESS || '')}@cluster0.n1c8q.mongodb.net`;
const COLLECTION_NAME = 'Invoices'; 

const PROJECT_ROOT_OUTPUT_DIR = path.join(process.cwd(), 'data');
const ANALYSIS_RESULTS_FILE = path.join(PROJECT_ROOT_OUTPUT_DIR, 'analysisResults.json');
const UPDATE_PLAN_FILE = path.join(PROJECT_ROOT_OUTPUT_DIR, 'updatePlan.json');
const UPDATE_STATS_FILE = path.join(PROJECT_ROOT_OUTPUT_DIR, 'updateStats.json');

const CONFIDENCE_THRESHOLD = 90; 
const DATABASES = ['dentira', 'canada', 'australia', 'nz']; // Define DATABASES if not already global

// --- Global MongoDB Client ---
let mongoClient; 

/**
 * Initializes the MongoDB connection.
 */
async function initializeDbConnection() {
    if (!MONGODB_URI) {
        console.error("MongoDB URI not configured. Cannot initialize connection.".red);
        throw new Error("MongoDB URI not configured.");
    }
    if (!mongoClient || !mongoClient.topology || !mongoClient.topology.isConnected()) {
        console.log("\nConnecting to MongoDB for update session...".cyan);
        mongoClient = new MongoClient(MONGODB_URI);
        try {
            await mongoClient.connect();
            console.log("Successfully connected to MongoDB for this update session.".green);
        } catch (err) {
            console.error("FATAL: Could not connect to MongoDB at startup for updates.".red, err);
            if (err.cause) console.error("Cause:".red, err.cause);
            throw err; // Re-throw to be caught by main try/catch
        }
    } else {
        console.log("MongoDB connection already established for update session.".blue);
    }
}

/**
 * Closes the MongoDB connection.
 */
async function closeDbConnection() {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) {
        try {
            await mongoClient.close();
            console.log("\nMongoDB connection closed after update session.".grey);
        } catch (err) {
            console.error("Error closing MongoDB connection:".red, err);
        }
    }
}


/**
 * Reads the analysis results from the JSON file.
 * @returns {Promise<object|null>} The parsed analysis results or null if an error occurs.
 */
async function readAnalysisResults() {
    try {
        const data = await fs.readFile(ANALYSIS_RESULTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`Error: Analysis results file not found at ${ANALYSIS_RESULTS_FILE}`.red);
            console.log("Please run the main invoice analyzer script (index.js) first to generate analysisResults.json".yellow);
        } else {
            console.error(`Error reading or parsing ${ANALYSIS_RESULTS_FILE}:`.red, error);
        }
        return null;
    }
}

/**
 * Filters analysis results and prepares an update plan.
 * @param {object} analysisResults - The parsed analysis results.
 * @returns {Array<object>} An array of update operations to be performed.
 */
function prepareUpdatePlan(analysisResults) {
    const updatePlan = [];
    if (!analysisResults || typeof analysisResults !== 'object') {
        console.warn("No valid analysis results to process for update plan.".yellow);
        return updatePlan;
    }

    for (const fileName in analysisResults) {
        const result = analysisResults[fileName];
        if (
            result.report_type === "SHIPTOISSUE" &&
            result.suggested_fix_data &&
            result.suggested_fix_data.ship_to && 
            typeof result.suggested_fix_data.confidence === 'number' &&
            result.suggested_fix_data.confidence >= CONFIDENCE_THRESHOLD
        ) {
            if (result.original_data_snippet && result.original_data_snippet.inv_num && result.original_data_snippet.group_id) { // Ensure group_id is present
                 updatePlan.push({
                    file_name: fileName,
                    group_id: result.original_data_snippet.group_id, 
                    inv_num: result.original_data_snippet.inv_num,
                    current_ship_to: result.original_data_snippet.ship_to || null, 
                    suggested_ship_to: result.suggested_fix_data.ship_to,
                    confidence: result.suggested_fix_data.confidence
                });
            } else {
                console.warn(`Skipping update for ${fileName} due to missing group_id or inv_num in original_data_snippet.`.yellow);
            }
        }
    }
    return updatePlan;
}

/**
 * Writes the update plan to a JSON file.
 * @param {Array<object>} updatePlan - The plan to write.
 */
async function writeUpdatePlanToFile(updatePlan) {
    try {
        await fs.mkdir(PROJECT_ROOT_OUTPUT_DIR, { recursive: true });
        const fileContent = JSON.stringify(updatePlan, null, 2);
        await fs.writeFile(UPDATE_PLAN_FILE, fileContent);
        console.log(`\nUpdate plan written to ${UPDATE_PLAN_FILE}`.green);
        console.log(`Please review this file carefully before proceeding with database updates.`.yellow);
    } catch (error) {
        console.error('Error writing update plan to file:'.red, error);
    }
}

/**
 * Writes update statistics to a JSON file.
 * @param {object} stats - The statistics object.
 */
async function writeUpdateStatsToFile(stats) {
    try {
        await fs.mkdir(PROJECT_ROOT_OUTPUT_DIR, { recursive: true });
        const fileContent = JSON.stringify(stats, null, 2);
        await fs.writeFile(UPDATE_STATS_FILE, fileContent);
        console.log(`\nUpdate statistics written to ${UPDATE_STATS_FILE}`.green);
    } catch (error) {
        console.error('Error writing update statistics to file:'.red, error);
    }
}


/**
 * Prompts the user for confirmation and update mode.
 * @param {number} plannedUpdateCount - Number of updates in the plan.
 * @returns {Promise<object>} User's choices.
 */
async function askForUpdateExecution(plannedUpdateCount) {
    if (plannedUpdateCount === 0) {
        console.log("\nNo updates planned based on the criteria. Nothing to execute.".yellow);
        return { proceed: false, mode: null };
    }

    const { proceed } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'proceed',
            message: `The update plan in ${UPDATE_PLAN_FILE} contains ${plannedUpdateCount} potential update(s). Do you want to proceed with updating the database?`,
            default: false,
        }
    ]);

    if (!proceed) {
        console.log("Database update aborted by user.".yellow);
        return { proceed: false, mode: null };
    }

    const { mode } = await inquirer.prompt([
        {
            type: 'list',
            name: 'mode',
            message: 'Select update mode:',
            choices: [
                { name: `Update ALL ${plannedUpdateCount} planned record(s).`, value: 'all' },
                { name: 'Test with the FIRST record only.', value: 'first' },
                { name: 'Cancel update.', value: 'cancel'}
            ],
            default: 'cancel',
        }
    ]);
    
    if (mode === 'cancel') {
        console.log("Database update cancelled by user.".yellow);
        return { proceed: false, mode: null };
    }

    return { proceed: true, mode };
}

/**
 * Executes database updates based on the plan and user choice.
 * @param {MongoClient} client - The connected MongoDB client instance.
 * @param {Array<object>} updatePlan - The list of updates to perform.
 * @param {string} mode - 'all' or 'first'.
 * @param {string} databaseName - The name of the database to connect to.
 */
async function executeDatabaseUpdates(client, updatePlan, mode, databaseName) {
    let successCount = 0;
    let failureCount = 0;
    const failedUpdates = [];

    try {
        const db = client.db(databaseName);
        const collection = db.collection(COLLECTION_NAME);
        console.log(`\nUsing database: ${databaseName} for updates.`.green);

        const itemsToUpdate = mode === 'first' ? updatePlan.slice(0, 1) : updatePlan;
        if (mode === 'first' && updatePlan.length > 0) {
            console.log("Executing update for the FIRST record only as a test.".yellow);
        } else if (mode === 'all') {
            console.log(`Executing ALL ${itemsToUpdate.length} planned updates.`.yellow);
        }

        for (const item of itemsToUpdate) {
            console.log(`\nProcessing update for inv_num: ${item.inv_num}, group_id: ${item.group_id}`.blue);
            const filter = {
                group_id: item.group_id,
                inv_num: item.inv_num,
                "exceptions.header.exception_type": "PO_NOT_FOUND", 
                "status": "DISPUTED",                               
                $or: [{ ship_to: { $exists: false } }, { ship_to: "" }, { ship_to: null }, {ship_to: item.current_ship_to}] 
            };
            const updateDoc = {
                $set: { ship_to: item.suggested_ship_to },
            };

            console.log("Filter:".grey, JSON.stringify(filter));
            console.log("Update:".grey, JSON.stringify(updateDoc));

            try {
                const result = await collection.updateOne(filter, updateDoc);
                if (result.matchedCount > 0 && result.modifiedCount > 0) {
                    console.log(`Successfully updated ship_to for inv_num: ${item.inv_num}`.green);
                    successCount++;
                } else if (result.matchedCount > 0 && result.modifiedCount === 0) {
                    console.warn(`Document found for inv_num: ${item.inv_num}, but ship_to was already '${item.suggested_ship_to}' or no change needed.`.yellow);
                } else {
                    console.warn(`No document matched the filter for inv_num: ${item.inv_num}. It might have been updated or changed since analysis.`.yellow);
                    failedUpdates.push({ ...item, error: "No matching document found or no modification needed." });
                    failureCount++;
                }
            } catch (error) {
                console.error(`Error updating inv_num: ${item.inv_num}:`.red, error);
                failedUpdates.push({ ...item, error: error.message });
                failureCount++;
            }
        }
    } catch (error) {
        // This catch is for errors within the loop or getting db/collection, not for initial connection
        console.error("Error during database update execution loop:".red, error);
        // Mark remaining items as failed if a general error occurs mid-process
        const remainingItems = updatePlan.length - (successCount + failureCount);
        if (remainingItems > 0) {
             failureCount += remainingItems;
             // Add details for items that were not attempted
        }
    }
    return { successCount, failureCount, failedUpdates };
}


/**
 * Main function for the DB update script.
 */
async function runDbUpdateScript() {
    console.log("--- Invoice Database Updater Script ---".bold.underline.blue);

    try {
        await initializeDbConnection(); // Connect once at the start

        const analysisResults = await readAnalysisResults();
        if (!analysisResults) {
            return; 
        }

        const updatePlan = prepareUpdatePlan(analysisResults);
        await writeUpdatePlanToFile(updatePlan);

        if (updatePlan.length === 0) {
            console.log("\nNo actionable updates found in the analysis results based on the criteria.".yellow);
            await writeUpdateStatsToFile({
                total_planned_updates: 0, updates_attempted: 0, successful_updates: 0,
                failed_updates: 0, failures_details: []
            });
            return;
        }

        const dbNamePrompt = await inquirer.prompt([
            {
                type: 'list', name: 'database_name', message: 'Which database do these updates apply to?',
                choices: DATABASES, default: 'dentira' 
            }
        ]);
        const targetDatabaseName = dbNamePrompt.database_name;

        const executionChoice = await askForUpdateExecution(updatePlan.length);

        if (executionChoice.proceed && executionChoice.mode) {
            // Pass the global mongoClient to executeDatabaseUpdates
            const stats = await executeDatabaseUpdates(mongoClient, updatePlan, executionChoice.mode, targetDatabaseName);
            
            console.log("\n--- Update Execution Summary ---".bold.cyan);
            console.log(`Updates Attempted: ${stats.successCount + stats.failureCount}`.blue);
            console.log(`Successful Updates: ${stats.successCount}`.green);
            console.log(`Failed Updates: ${stats.failureCount}`.red);

            await writeUpdateStatsToFile({
                timestamp: new Date().toISOString(), database_updated: targetDatabaseName,
                total_planned_updates: updatePlan.length, mode_selected: executionChoice.mode,
                updates_attempted: stats.successCount + stats.failureCount,
                successful_updates: stats.successCount, failed_updates: stats.failureCount,
                failures_details: stats.failedUpdates
            });

            if (stats.failureCount > 0) {
                console.log("Details of failed updates are logged in updateStats.json".yellow);
            }
        } else {
            console.log("No database updates were performed.".yellow);
            await writeUpdateStatsToFile({
                timestamp: new Date().toISOString(), database_updated: targetDatabaseName,
                total_planned_updates: updatePlan.length, mode_selected: "cancelled",
                updates_attempted: 0, successful_updates: 0, failed_updates: 0,
                failures_details: []
            });
        }
    } catch (error) {
        console.error("An error occurred in the DB Update Script:".red, error);
        if (error.cause) console.error("Cause:".red, error.cause);
    } finally {
        await closeDbConnection(); // Close connection when script finishes or errors out
    }
}

runDbUpdateScript();
