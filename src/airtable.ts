import { config } from "./config";

export interface AirtableEventFields {
  Hash: string;
  Name: string;
  "Start Date": string;
  "Start Time"?: string | null;
  "End Time"?: string | null;
  "End Date"?: string | null;
  Location?: string | null;
  Description?: string;
  URL?: string | null;
  Category?: string;
  "Source Chat"?: string;
  Favorited?: boolean;
  "Created At"?: string;
}

function getHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.airtableApiKey}`,
    "Content-Type": "application/json",
  };
}

function getBaseUrl(): string {
  return `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableTableId)}`;
}

export function isConfigured(): boolean {
  return !!(config.airtableApiKey && config.airtableBaseId && config.airtableTableId);
}

/** Create a single record. Returns the Airtable record ID, or null on failure. */
export async function airtableCreate(fields: AirtableEventFields): Promise<string | null> {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(getBaseUrl(), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ fields: cleanFields(fields) }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[airtable] CREATE failed (${res.status}): ${body}`);
      return null;
    }
    const data = (await res.json()) as { id: string };
    console.log(`[airtable] Created record ${data.id} for "${fields.Name}"`);
    return data.id;
  } catch (err: any) {
    console.error(`[airtable] CREATE error: ${err?.message || err}`);
    return null;
  }
}

/** Update a record's fields. */
export async function airtableUpdate(
  recordId: string,
  fields: Partial<AirtableEventFields>
): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(`${getBaseUrl()}/${recordId}`, {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify({ fields: cleanFields(fields) }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[airtable] UPDATE failed (${res.status}): ${body}`);
      return false;
    }
    console.log(`[airtable] Updated record ${recordId}`);
    return true;
  } catch (err: any) {
    console.error(`[airtable] UPDATE error: ${err?.message || err}`);
    return false;
  }
}

/** Delete a record. */
export async function airtableDelete(recordId: string): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(`${getBaseUrl()}/${recordId}`, {
      method: "DELETE",
      headers: getHeaders(),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[airtable] DELETE failed (${res.status}): ${body}`);
      return false;
    }
    console.log(`[airtable] Deleted record ${recordId}`);
    return true;
  } catch (err: any) {
    console.error(`[airtable] DELETE error: ${err?.message || err}`);
    return false;
  }
}

/** Batch create records (max 10 per request). Returns hash→recordId pairs. */
export async function airtableBatchCreate(
  recordFields: AirtableEventFields[]
): Promise<Array<{ hash: string; recordId: string }>> {
  if (!isConfigured() || recordFields.length === 0) return [];

  const results: Array<{ hash: string; recordId: string }> = [];

  for (let i = 0; i < recordFields.length; i += 10) {
    const batch = recordFields.slice(i, i + 10);
    try {
      const res = await fetch(getBaseUrl(), {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          records: batch.map((fields) => ({ fields: cleanFields(fields) })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[airtable] BATCH CREATE failed (${res.status}): ${body}`);
        continue;
      }
      const data = (await res.json()) as { records: Array<{ id: string }> };
      for (let j = 0; j < data.records.length; j++) {
        results.push({
          hash: batch[j].Hash,
          recordId: data.records[j].id,
        });
      }
      console.log(`[airtable] Batch created ${data.records.length} records (${i + data.records.length}/${recordFields.length})`);
    } catch (err: any) {
      console.error(`[airtable] BATCH CREATE error: ${err?.message || err}`);
    }
    // Small delay between batches to respect Airtable rate limit (5 req/s)
    if (i + 10 < recordFields.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return results;
}

/** Convert a StoredEvent-like object to Airtable field format. */
export function toAirtableFields(event: {
  hash: string;
  name: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  endDate: string | null;
  location: string | null;
  description: string;
  url: string | null;
  category: string;
  sourceChat: string;
  favorited: boolean;
  createdAt: string;
}): AirtableEventFields {
  return {
    Hash: event.hash,
    Name: event.name,
    "Start Date": event.date,
    "Start Time": event.startTime,
    "End Time": event.endTime,
    "End Date": event.endDate,
    Location: event.location,
    Description: event.description,
    URL: event.url,
    Category: event.category,
    "Source Chat": event.sourceChat,
    Favorited: event.favorited,
    "Created At": event.createdAt,
  };
}

/** Remove null/undefined values — Airtable rejects explicit nulls for some field types. */
function cleanFields(fields: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
