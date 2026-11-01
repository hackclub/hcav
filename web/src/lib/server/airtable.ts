import { error } from '@sveltejs/kit';
import { required } from './config';

type Fields = Record<string, string | boolean | number>;
type RecordRow<T> = { id: string; fields: T };
export type Person = {
	id: string;
	name: string;
	email?: string;
	email_verified?: boolean;
	slack_id?: string;
	verification_status?: string;
	ysws_eligible?: boolean;
	team_id?: string;
};
export type Team = {
	id: string;
	name: string;
	captain_id: string;
	link_token: string;
	link_expires: string;
	open_registration?: boolean;
	hq_channel_id?: string;
	hq_channel_name?: string;
	'Total Points'?: number;
};

// Airtable allows five requests/second/base. Queue reads as well as writes.
let tail = Promise.resolve();
let nextRequest = 0;
async function request<T>(table: string, query = '', body?: object): Promise<T> {
	const previous = tail;
	let release!: () => void;
	tail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextRequest - Date.now())));
		nextRequest = Date.now() + 220;
		const response = await fetch(
			`https://api.airtable.com/v0/${required('AIRTABLE_BASE_ID')}/${encodeURIComponent(table)}${query}`,
			{
				method: body ? 'PATCH' : 'GET',
				headers: {
					Authorization: `Bearer ${required('AIRTABLE_TOKEN')}`,
					'Content-Type': 'application/json'
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(10_000)
			}
		);
		if (!response.ok) {
			console.error('airtable request failed', table, response.status);
			error(503, 'The filing cabinet is unavailable. Please try again shortly.');
		}
		return await response.json();
	} catch (cause) {
		if (cause instanceof TypeError || (cause instanceof Error && cause.name === 'TimeoutError')) {
			error(503, 'The filing cabinet is unavailable. Please try again shortly.');
		}
		throw cause;
	} finally {
		release();
	}
}

function literal(value: string) {
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export async function rows<T>(table: string, field?: string, value = ''): Promise<T[]> {
	const records: T[] = [];
	let offset = '';
	do {
		const query = new URLSearchParams(
			field ? { filterByFormula: `{${field}}=${literal(value)}` } : {}
		);
		if (offset) query.set('offset', offset);
		const page = await request<{ records: RecordRow<T>[]; offset?: string }>(table, `?${query}`);
		records.push(...page.records.map((row) => row.fields));
		offset = page.offset || '';
	} while (offset);
	return records;
}

export async function upsert(table: string, fields: Fields) {
	await request(table, '', { performUpsert: { fieldsToMergeOn: ['id'] }, records: [{ fields }] });
}

export async function person(id: string) {
	return (await rows<Person>('people', 'id', id))[0];
}
export async function team(id: string) {
	return (await rows<Team>('teams', 'id', id))[0];
}
export async function members(id: string) {
	return rows<Person>('people', 'team_id', id);
}
