export const GEMMA_PROMPT_TEMPLATES = {
    "PENDING_CONFIRMATION": {
        base_prompt: "You are an expert invoice analyst. This invoice (file: {file_name}) is in 'PENDING_CONFIRMATION' status.\n" +
                     "Invoice JSON Data:\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "Determine the primary reason for 'PENDING_CONFIRMATION' by checking for these common issues: {criteria_list}.\n" +
                     "Respond with ONLY the single most critical reason as a concise string. " +
                     "If the primary reason is a missing invoice number (inv_num) in the JSON data, AND you can confidently identify the correct invoice number from the PDF content, " +
                     "append the following on a new line: SUGGESTED_FIX_DATA: {\"inv_num\": \"<identified_invoice_number>\"}. " +
                     "If no fix is suggested, only provide the reason. If no listed issues are found, state 'No specific listed criteria met for PENDING_CONFIRMATION'.",
        criteria: [
            "Invoice number (inv_num) is missing or empty.",
            "Total amount (total) is missing or zero.",
            "Line items (line_items) array is missing or empty.",
            "Invoice date (inv_date) is missing.",
            "Invoice date (inv_date) is in the future compared to the current date ({current_date}).",
            "Supplier name (supplier_extra_info.name or supplier field) is missing."
        ]
    },
    "INV_AMOUNT_VARIANCE": {
        base_prompt: "You are an expert invoice analyst. This invoice (file: {file_name}) has an 'INV_AMOUNT_VARIANCE' exception (difference: {exception_diff}) and is in 'DISPUTED' status.\n" +
                     "Invoice JSON Data:\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "What is the likely cause of this amount variance? Focus on: {criteria_list}.\n" +
                     "Respond with ONLY the single most likely cause as a concise string. "+
                     "If you can confidently identify a missing value (e.g., shipping cost of 30.00) from the PDF content that would resolve the variance, "+
                     "append the following on a new line: SUGGESTED_FIX_DATA: {\"<field_name>\": <identified_value>}.",
        criteria: [ "Sum of line_items[N].price + taxes + shipping does not equal total.", "sub_total + taxes + shipping does not equal total.", "discount_amount not correctly applied to calculate total.", "shipping cost seems duplicated or incorrectly included in sub_total." ]
    },
    "PO_NOT_FOUND": {
        base_prompt: "You are an expert invoice analyst. Invoice (file: {file_name}) has 'PO_NOT_FOUND' exception. JSON 'po_num' is '{po_num_value}'.\n" +
                     "Invoice JSON Data:\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "Why might PO be missing/not found? Check: {criteria_list}.\n" +
                     "Respond with ONLY the most probable reason as a concise string. "+
                     "If you can confidently identify the correct PO number from the PDF content, "+
                     "append the following on a new line: SUGGESTED_FIX_DATA: {\"po_num\": \"<identified_po_number>\"}.",
        criteria: [ "po_num field is empty or null in JSON.", "PO number format in JSON appears incorrect or incomplete.", "Supplier information or terms might indicate PO is not always required." ]
    },
    "ITEM_UNMATCHED": { 
        base_prompt: "You are an expert invoice analyst. Invoice (file: {file_name}) has 'ITEM_UNMATCHED' exception.\n" +
                     "Invoice JSON Data (line items section is most relevant):\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "Why might items be unmatched? Consider: {criteria_list}.\n" +
                     "Respond with ONLY the most probable reason as a concise string. "+
                     "If you can suggest corrections for line items based on the PDF (e.g., a corrected SKU or quantity), "+
                     "append on a new line: SUGGESTED_FIX_DATA: {\"line_item_updates\": [{\"identifier\": {\"name\": \"<original_item_name_or_sku>\"}, \"corrections\": {\"supplier_product_id\": \"<corrected_sku>\", \"qty\": <corrected_qty>}}]}.",
        criteria: [ "supplier_product_id (SKU) is missing or unusual for one or more line items.", "Product 'name' or 'description' is vague or generic.", "Unit price or quantity seems implausible (e.g., zero or very high/low)." ]
    },
    "UNASSIGNED": { 
        base_prompt: "You are an expert invoice analyst. Invoice (file: {file_name}) 'pending_reason' is 'UNASSIGNED' and status 'PENDING_CONFIRMATION'.\n" +
                     "Invoice JSON Data:\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "What is the most likely reason it's unassigned? Check: {criteria_list}.\n" +
                     "Respond with ONLY the most probable reason as a concise string. "+
                     "If you can identify a clear supplier name from the PDF content that is missing/different in JSON, "+
                     "append on a new line: SUGGESTED_FIX_DATA: {\"supplier\": \"<identified_supplier_name>\"}.",
        criteria: [ "Supplier field is missing or unrecognized.", "Key identifying information like invoice number or PO number is missing, making routing difficult.", "Bill_to or ship_to address information is incomplete or ambiguous." ]
    },
     "SHIPTOISSUE": { 
        base_prompt: "You are an expert invoice analyst. Invoice (file: {file_name}) flagged for ship_to address issue, status 'DISPUTED'. 'ship_to' in JSON: '{ship_to_value}'.\n" +
                     "Invoice JSON Data:\n```json\n{json_data}\n```\n" +
                     "{pdf_content_section}\n" +
                     "Why might this be an issue, considering criteria like: {criteria_list}?\n" +
                     "Respond with ONLY the most probable reason as a concise string.",
        criteria: [ "ship_to field is empty, null, or missing.", "ship_to address seems incomplete (e.g., missing street, city, or postal code).", "ship_to address does not match expected format or known locations." ]
    }
};