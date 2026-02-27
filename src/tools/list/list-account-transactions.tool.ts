import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listXeroAccountTransactions } from "../../handlers/list-xero-account-transactions.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListAccountTransactionsTool = CreateXeroTool(
  "list-account-transactions",
  `List account transactions from Xero. This produces a per-account ledger showing \
date, source type, contact, description, reference, debit, credit, net, VAT, \
and the related account from the other side of each double-entry journal. \
Fetches from Invoices, Credit Notes, Bank Transactions, and Manual Journals in parallel \
with date-range filtering, then filters by account code client-side. \
Ask the user for a date range and one or more account codes (or account IDs) before calling. \
Both fromDate and toDate are required (YYYY-MM-DD). \
You can pass multiple account codes or IDs as arrays to get transactions across several accounts in one call. \
Results are written to a temp file to avoid loading large datasets into context. \
The response includes a summary header and the file path — use the Read tool to inspect the file. \
Note: this covers invoices, credit notes, bank transactions, and manual journals. \
Payroll journals and system-generated entries are not included.`,
  {
    fromDate: z
      .string()
      .describe("Start date in YYYY-MM-DD format (required)"),
    toDate: z
      .string()
      .describe("End date in YYYY-MM-DD format (required)"),
    accountCodes: z
      .array(z.string())
      .optional()
      .describe("Filter by one or more account codes, e.g. ['200', '400']"),
    accountIds: z
      .array(z.string())
      .optional()
      .describe("Filter by one or more account UUIDs"),
    sourceType: z
      .string()
      .optional()
      .describe(
        "Filter by source type: ACCREC, ACCPAY, ACCRECCREDIT, ACCPAYCREDIT, CASHREC, CASHPAID, MANJOURNAL",
      ),
  },
  async ({ fromDate, toDate, accountCodes, accountIds, sourceType }) => {
    const response = await listXeroAccountTransactions(
      fromDate,
      toDate,
      accountCodes,
      accountIds,
      sourceType,
    );

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing account transactions: ${response.error}`,
          },
        ],
      };
    }

    const { rows, warnings } = response.result;
    const accountLabel = accountCodes?.length
      ? `accounts ${accountCodes.join(", ")}`
      : accountIds?.length
        ? `accounts ${accountIds.join(", ")}`
        : "all accounts";

    // Write rows to a temp file to keep the MCP response small
    const tmpFile = path.join(
      os.tmpdir(),
      `xero-acct-txns-${Date.now()}.json`,
    );
    fs.writeFileSync(tmpFile, JSON.stringify(rows, null, 2));

    const headerLines = [
      `Account Transactions for ${accountLabel}`,
      `Date range: ${fromDate} to ${toDate}`,
      `Rows returned: ${rows.length}`,
      `Results file: ${tmpFile}`,
    ];
    if (warnings.length > 0) {
      headerLines.push("", "Warnings:", ...warnings.map((w) => `  - ${w}`));
    }

    return {
      content: [
        { type: "text" as const, text: headerLines.join("\n") },
      ],
    };
  },
);

export default ListAccountTransactionsTool;
