import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountTransactionRow {
  date: string;
  source: string;
  contactName: string | null;
  description: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  net: number | null;
  gross: number | null;
  vat: number | null;
  accountCode: string | null;
  accountName: string | null;
  relatedAccount: string | null;
}

export interface AccountTransactionsResult {
  rows: AccountTransactionRow[];
  hasMore: boolean;
  nextOffset: number | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
const MJ_PAGE_SIZE = 1000; // manual journals need larger pages due to high volume
const MAX_PAGES = 50; // safety cap per endpoint
const MAX_RETRIES = 5;
const RETRY_BUFFER_MS = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse the Xero SDK error (which may be a JSON string) into an object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseXeroError(error: unknown): any {
  if (typeof error === "string") {
    try {
      return JSON.parse(error);
    } catch {
      return null;
    }
  }
  return error;
}

/** Extract retry-after milliseconds from a Xero 429 error response. */
function getRetryAfterMs(error: unknown): number | null {
  const parsed = parseXeroError(error);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = (parsed as any)?.response;
  if (resp?.statusCode === 429 || resp?.status === 429) {
    const retryAfter = resp.headers?.["retry-after"];
    const seconds = retryAfter ? parseInt(String(retryAfter), 10) : 60;
    return (isNaN(seconds) ? 60 : seconds) * 1000 + RETRY_BUFFER_MS;
  }
  return null;
}

/** Retry a function on 429 rate-limit errors. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const waitMs = getRetryAfterMs(err);
      if (waitMs !== null && attempt < MAX_RETRIES) {
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

/** Check if a line item's account matches the filter criteria. */
function lineMatchesAccount(
  lineAccountCode: string | undefined,
  lineAccountId: string | undefined,
  filterCodes?: string[],
  filterIds?: string[],
): boolean {
  if (filterCodes?.length && lineAccountCode && filterCodes.includes(lineAccountCode)) return true;
  if (filterIds?.length && lineAccountId && filterIds.includes(lineAccountId)) return true;
  return !filterCodes?.length && !filterIds?.length; // no filter = match all
}

/** Build a Xero WHERE clause for a date range. */
function buildDateWhere(fromDate: string, toDate: string): string {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  return `Date>=DateTime(${fy},${fm},${fd})&&Date<=DateTime(${ty},${tm},${td})`;
}

/** Normalise a date value (Date object or string) to YYYY-MM-DD. */
function formatDate(d: unknown): string {
  if (d instanceof Date) return d.toISOString().substring(0, 10);
  if (typeof d === "string") return d.substring(0, 10);
  return "";
}

// ---------------------------------------------------------------------------
// Account name lookup (1 API call)
// ---------------------------------------------------------------------------

async function buildAccountNameMap(): Promise<Map<string, string>> {
  const headers = getClientHeaders();
  const resp = await withRetry(() =>
    xeroClient.accountingApi.getAccounts(
      xeroClient.tenantId,
      undefined,
      undefined,
      undefined,
      headers,
    ),
  );
  const map = new Map<string, string>();
  for (const acct of resp.body.accounts ?? []) {
    if (acct.code) map.set(acct.code, acct.name ?? "");
  }
  return map;
}

// ---------------------------------------------------------------------------
// Endpoint fetchers
// ---------------------------------------------------------------------------

// --- Invoices (ACCREC / ACCPAY) ---

async function fetchInvoiceRows(
  fromDate: string,
  toDate: string,
  accountCodes: string[] | undefined,
  accountIds: string[] | undefined,
  sourceType: string | undefined,
): Promise<AccountTransactionRow[]> {
  if (sourceType && sourceType !== "ACCREC" && sourceType !== "ACCPAY") return [];

  const headers = getClientHeaders();
  let where = buildDateWhere(fromDate, toDate);
  where += '&&Status!="DRAFT"&&Status!="DELETED"';
  if (sourceType === "ACCREC") where += '&&Type=="ACCREC"';
  else if (sourceType === "ACCPAY") where += '&&Type=="ACCPAY"';

  const rows: AccountTransactionRow[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const resp = await withRetry(() =>
      xeroClient.accountingApi.getInvoices(
        xeroClient.tenantId,
        undefined, // ifModifiedSince
        where,
        undefined, // order
        undefined, // iDs
        undefined, // invoiceNumbers
        undefined, // contactIDs
        undefined, // statuses
        page,
        false, // includeArchived
        false, // createdByMyApp
        undefined, // unitdp
        false, // summaryOnly — need line items
        PAGE_SIZE,
        undefined, // searchTerm
        headers,
      ),
    );

    const invoices = resp.body.invoices ?? [];

    for (const inv of invoices) {
      const typeStr = String(inv.type ?? "");
      const isAccPay = typeStr === "ACCPAY";
      const sourceLabel = isAccPay ? "Purchase Invoice" : "Sales Invoice";
      const contactName = inv.contact?.name ?? null;
      const date = formatDate(inv.date);

      for (const li of inv.lineItems ?? []) {
        if (!lineMatchesAccount(li.accountCode, li.accountID, accountCodes, accountIds)) continue;

        const lineAmt = li.lineAmount ?? 0;
        // ACCPAY: DR line-item account, CR Accounts Payable
        // ACCREC: DR Accounts Receivable, CR line-item account
        const netToAccount = isAccPay ? lineAmt : -lineAmt;

        const taxAmt = li.taxAmount ?? 0;

        rows.push({
          date,
          source: sourceLabel,
          contactName,
          description: li.description ?? null,
          invoiceNumber: inv.invoiceNumber ?? null,
          reference: inv.reference ?? null,
          debit: netToAccount > 0 ? netToAccount : null,
          credit: netToAccount < 0 ? Math.abs(netToAccount) : null,
          net: lineAmt,
          gross: lineAmt + taxAmt,
          vat: taxAmt,
          accountCode: li.accountCode ?? null,
          accountName: null, // filled later
          relatedAccount: null,
        });
      }
    }

    if (invoices.length < PAGE_SIZE) break;
    page++;
  }

  return rows;
}

// --- Credit Notes (ACCRECCREDIT / ACCPAYCREDIT) ---

async function fetchCreditNoteRows(
  fromDate: string,
  toDate: string,
  accountCodes: string[] | undefined,
  accountIds: string[] | undefined,
  sourceType: string | undefined,
): Promise<AccountTransactionRow[]> {
  if (sourceType && sourceType !== "ACCRECCREDIT" && sourceType !== "ACCPAYCREDIT") return [];

  const headers = getClientHeaders();
  let where = buildDateWhere(fromDate, toDate);
  where += '&&Status!="DRAFT"&&Status!="DELETED"';
  if (sourceType === "ACCRECCREDIT") where += '&&Type=="ACCRECCREDIT"';
  else if (sourceType === "ACCPAYCREDIT") where += '&&Type=="ACCPAYCREDIT"';

  const rows: AccountTransactionRow[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const resp = await withRetry(() =>
      xeroClient.accountingApi.getCreditNotes(
        xeroClient.tenantId,
        undefined, // ifModifiedSince
        where,
        undefined, // order
        page,
        undefined, // unitdp
        PAGE_SIZE,
        headers,
      ),
    );

    const creditNotes = resp.body.creditNotes ?? [];

    for (const cn of creditNotes) {
      const typeStr = String(cn.type ?? "");
      // ACCPAYCREDIT reverses ACCPAY: CR line-item account
      // ACCRECCREDIT reverses ACCREC: DR line-item account
      const isDebitToAccount = typeStr === "ACCRECCREDIT";
      const sourceLabel =
        typeStr === "ACCPAYCREDIT"
          ? "Purchase Credit Note"
          : "Sales Credit Note";
      const contactName = cn.contact?.name ?? null;
      const date = formatDate(cn.date);

      for (const li of cn.lineItems ?? []) {
        if (!lineMatchesAccount(li.accountCode, li.accountID, accountCodes, accountIds)) continue;

        const lineAmt = li.lineAmount ?? 0;
        const netToAccount = isDebitToAccount ? lineAmt : -lineAmt;
        const taxAmt = li.taxAmount ?? 0;

        rows.push({
          date,
          source: sourceLabel,
          contactName,
          description: li.description ?? null,
          invoiceNumber: cn.creditNoteNumber ?? null,
          reference: cn.reference ?? null,
          debit: netToAccount > 0 ? netToAccount : null,
          credit: netToAccount < 0 ? Math.abs(netToAccount) : null,
          net: lineAmt,
          gross: lineAmt + taxAmt,
          vat: taxAmt,
          accountCode: li.accountCode ?? null,
          accountName: null,
          relatedAccount: null,
        });
      }
    }

    if (creditNotes.length < PAGE_SIZE) break;
    page++;
  }

  return rows;
}

// --- Bank Transactions (SPEND / RECEIVE) ---

async function fetchBankTransactionRows(
  fromDate: string,
  toDate: string,
  accountCodes: string[] | undefined,
  accountIds: string[] | undefined,
  sourceType: string | undefined,
): Promise<AccountTransactionRow[]> {
  if (sourceType && sourceType !== "CASHREC" && sourceType !== "CASHPAID") return [];

  const headers = getClientHeaders();
  let where = buildDateWhere(fromDate, toDate);
  where += '&&Status!="DELETED"';
  if (sourceType === "CASHREC") where += '&&Type=="RECEIVE"';
  else if (sourceType === "CASHPAID") where += '&&Type=="SPEND"';

  const rows: AccountTransactionRow[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const resp = await withRetry(() =>
      xeroClient.accountingApi.getBankTransactions(
        xeroClient.tenantId,
        undefined, // ifModifiedSince
        where,
        undefined, // order
        page,
        undefined, // unitdp
        PAGE_SIZE,
        headers,
      ),
    );

    const txns = resp.body.bankTransactions ?? [];

    for (const bt of txns) {
      const typeStr = String(bt.type ?? "");
      const isSpend = typeStr === "SPEND";
      const sourceLabel = isSpend ? "Spend Money" : "Receive Money";
      const contactName = bt.contact?.name ?? null;
      const date = formatDate(bt.date);
      const bankAcctCode = bt.bankAccount?.code;
      const bankAcctName = bt.bankAccount?.name;

      // Check line items (the non-bank side of the transaction)
      for (const li of bt.lineItems ?? []) {
        if (!lineMatchesAccount(li.accountCode, li.accountID, accountCodes, accountIds)) continue;

        const lineAmt = li.lineAmount ?? 0;
        // SPEND: DR line-item account, CR bank account
        // RECEIVE: DR bank account, CR line-item account
        const netToAccount = isSpend ? lineAmt : -lineAmt;
        const taxAmt = li.taxAmount ?? 0;

        rows.push({
          date,
          source: sourceLabel,
          contactName,
          description: li.description ?? null,
          invoiceNumber: null,
          reference: bt.reference ?? null,
          debit: netToAccount > 0 ? netToAccount : null,
          credit: netToAccount < 0 ? Math.abs(netToAccount) : null,
          net: lineAmt,
          gross: lineAmt + taxAmt,
          vat: taxAmt,
          accountCode: li.accountCode ?? null,
          accountName: null,
          relatedAccount: bankAcctCode
            ? `${bankAcctCode} - ${bankAcctName ?? ""}`.trim()
            : null,
        });
      }

      // Also check if the bank account itself matches the filter
      if (lineMatchesAccount(bankAcctCode, bt.bankAccount?.accountID, accountCodes, accountIds)) {
        const totalAmount = bt.total ?? 0;
        const subTotal = bt.subTotal ?? 0;
        const totalTax = bt.totalTax ?? 0;
        // For the bank side: SPEND = CR (money out), RECEIVE = DR (money in)
        const netToAccount = isSpend ? -totalAmount : totalAmount;
        const firstLineAccount = bt.lineItems?.[0]?.accountCode;

        rows.push({
          date,
          source: sourceLabel,
          contactName,
          description:
            bt.lineItems
              ?.map((l) => l.description)
              .filter(Boolean)
              .join("; ") ?? null,
          invoiceNumber: null,
          reference: bt.reference ?? null,
          debit: netToAccount > 0 ? netToAccount : null,
          credit: netToAccount < 0 ? Math.abs(netToAccount) : null,
          net: subTotal,
          gross: totalAmount,
          vat: totalTax,
          accountCode: bankAcctCode ?? null,
          accountName: bankAcctName ?? null,
          relatedAccount: firstLineAccount ?? null,
        });
      }
    }

    if (txns.length < PAGE_SIZE) break;
    page++;
  }

  return rows;
}

// --- Manual Journals ---

interface FetchResult {
  rows: AccountTransactionRow[];
  truncated: boolean;
  scanned: number;
}

async function fetchManualJournalRows(
  fromDate: string,
  toDate: string,
  accountCodes: string[] | undefined,
  accountIds: string[] | undefined,
  sourceType: string | undefined,
): Promise<FetchResult> {
  if (sourceType && sourceType !== "MANJOURNAL") return { rows: [], truncated: false, scanned: 0 };

  const headers = getClientHeaders();
  let where = buildDateWhere(fromDate, toDate);
  where += '&&Status!="DRAFT"';

  const rows: AccountTransactionRow[] = [];
  let page = 1;
  let totalScanned = 0;

  while (page <= MAX_PAGES) {
    // Pass ifModifiedSince to satisfy Xero's high-volume efficiency check.
    // Using fromDate ensures we don't miss any journals created/modified in the range.
    const ifModifiedSince = new Date(fromDate + "T00:00:00Z");

    const resp = await withRetry(() =>
      xeroClient.accountingApi.getManualJournals(
        xeroClient.tenantId,
        ifModifiedSince,
        where,
        "Date DESC", // order by date descending for predictable pagination
        page,
        MJ_PAGE_SIZE,
        headers,
      ),
    );

    const journals = resp.body.manualJournals ?? [];
    totalScanned += journals.length;

    for (const mj of journals) {
      const date = formatDate(mj.date);
      const allLines = mj.journalLines ?? [];
      const matchingLines = allLines.filter((l) =>
        lineMatchesAccount(l.accountCode, l.accountID, accountCodes, accountIds),
      );
      const otherLines = allLines.filter(
        (l) => !lineMatchesAccount(l.accountCode, l.accountID, accountCodes, accountIds),
      );

      const relatedAccount =
        otherLines.length > 0
          ? `${otherLines[0].accountCode ?? ""}`.trim()
          : null;

      for (const line of matchingLines) {
        // ManualJournalLine: positive lineAmount = debit, negative = credit
        const amt = line.lineAmount ?? 0;
        const taxAmt = line.taxAmount ?? 0;

        rows.push({
          date,
          source: "Manual Journal",
          contactName: null,
          description: line.description ?? mj.narration ?? null,
          invoiceNumber: null,
          reference: mj.narration ?? null,
          debit: amt > 0 ? amt : null,
          credit: amt < 0 ? Math.abs(amt) : null,
          net: amt,
          gross: amt + taxAmt,
          vat: taxAmt,
          accountCode: line.accountCode ?? null,
          accountName: null,
          relatedAccount,
        });
      }
    }

    if (journals.length < MJ_PAGE_SIZE) break;
    page++;
  }

  const truncated = page > MAX_PAGES;
  return { rows, truncated, scanned: totalScanned };
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function listXeroAccountTransactions(
  fromDate: string,
  toDate: string,
  accountCodes?: string[],
  accountIds?: string[],
  sourceType?: string,
): Promise<XeroClientResponse<AccountTransactionsResult>> {
  try {
    await xeroClient.authenticate();

    // Fetch from endpoints in two batches to stay under Xero's concurrent connection limit.
    // Use allSettled so one failing endpoint doesn't crash everything.
    const warnings: string[] = [];
    const rowArrays: AccountTransactionRow[][] = [];

    // Batch 1: Invoices + Credit Notes + Account names
    const batch1Labels = ["Invoices", "Credit Notes", "Accounts"];
    const batch1 = await Promise.allSettled([
      fetchInvoiceRows(fromDate, toDate, accountCodes, accountIds, sourceType),
      fetchCreditNoteRows(fromDate, toDate, accountCodes, accountIds, sourceType),
      buildAccountNameMap(),
    ]);

    for (let i = 0; i < 2; i++) {
      const r = batch1[i];
      if (r.status === "fulfilled") {
        rowArrays.push(r.value as AccountTransactionRow[]);
      } else {
        warnings.push(`${batch1Labels[i]} endpoint failed: ${formatError(r.reason)}`);
      }
    }

    const accountNameMap =
      batch1[2].status === "fulfilled"
        ? (batch1[2].value as Map<string, string>)
        : new Map<string, string>();
    if (batch1[2].status === "rejected") {
      warnings.push(`Account name lookup failed: ${formatError(batch1[2].reason)}`);
    }

    // Batch 2: Bank Transactions + Manual Journals
    const batch2 = await Promise.allSettled([
      fetchBankTransactionRows(fromDate, toDate, accountCodes, accountIds, sourceType),
      fetchManualJournalRows(fromDate, toDate, accountCodes, accountIds, sourceType),
    ]);

    // Bank Transactions
    const btResult = batch2[0];
    if (btResult.status === "fulfilled") {
      rowArrays.push(btResult.value as AccountTransactionRow[]);
    } else {
      warnings.push(`Bank Transactions endpoint failed: ${formatError(btResult.reason)}`);
    }

    // Manual Journals (returns FetchResult with truncation info)
    const mjResult = batch2[1];
    if (mjResult.status === "fulfilled") {
      const { rows: mjRows, truncated, scanned } = mjResult.value as FetchResult;
      rowArrays.push(mjRows);
      if (truncated) {
        warnings.push(
          `Manual Journals results may be incomplete: scanned ${scanned} journals but hit the pagination limit. ` +
          `Try narrowing the date range for complete results.`,
        );
      }
    } else {
      warnings.push(`Manual Journals endpoint failed: ${formatError(mjResult.reason)}`);
    }

    const allRows = rowArrays.flat();

    // Fill in account names from the lookup map
    for (const row of allRows) {
      if (row.accountCode && !row.accountName) {
        row.accountName = accountNameMap.get(row.accountCode) ?? null;
      }
      // Also resolve relatedAccount names
      if (row.relatedAccount && !row.relatedAccount.includes(" - ")) {
        const name = accountNameMap.get(row.relatedAccount);
        if (name) row.relatedAccount = `${row.relatedAccount} - ${name}`;
      }
    }

    // Sort by date descending
    allRows.sort((a, b) => b.date.localeCompare(a.date));

    return {
      result: { rows: allRows, hasMore: false, nextOffset: null, warnings },
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
