// Only loaded by the test runner, never imported by the app or copied into its image.
// Real app routes, real oidc validation and sqlite; external services are deterministic doubles.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

mkdirSync('../.amp/in', { recursive: true });
for (const suffix of ['', '-wal', '-shm'])
	rmSync(`../.amp/in/test.sqlite${suffix}`, { force: true });
const state = { people: [], teams: [], slack: [] };
const slackActors = new Map();
function slackId(actor) {
	if (actor === 'no-slack') return '';
	const id = `U${createHash('sha256')
		.update(actor.startsWith('duplicate-') ? 'duplicate' : actor)
		.digest('hex')
		.slice(0, 10)
		.toUpperCase()}`;
	slackActors.set(id, actor);
	return id;
}
state.teams.push({
	id: 'large-team',
	name: 'no maximum occupancy',
	captain_id: 'ident!large-captain',
	link_token: 'L'.repeat(43),
	link_expires: new Date(Date.now() + 86400_000).toISOString()
});
for (let index = 0; index < 104; index++) {
	state.people.push({
		id: index === 0 ? 'ident!large-captain' : `ident!large-member-${index}`,
		name: `large member ${index}`,
		slack_id: slackId(`large member ${index}`),
		email: `private-member-${index}@example.com`,
		team_id: 'large-team'
	});
}
for (let index = 0; index < 6; index++)
	state.teams.push({
		id: `directory-${index}`,
		name: `directory team ${index}`,
		captain_id: `ident!directory-${index}`,
		open_registration: index % 2 === 0,
		'Total Points': [0, 1, 52, 52, 100][index],
		link_token: String(index).repeat(43),
		link_expires: new Date(Date.now() + 86400_000).toISOString()
	});
state.teams.push({
	id: 'expired',
	name: 'expired team',
	captain_id: 'ident!expired',
	link_token: 'E'.repeat(43),
	link_expires: new Date(Date.now() - 1000).toISOString()
});
const persist = () => writeFileSync('../.amp/in/test-providers.json', JSON.stringify(state));
persist();
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const identities = new Map();
const issuer = 'https://auth.hackclub.com';
const realFetch = globalThis.fetch;
const json = (value, status = 200) => Response.json(value, { status });

globalThis.fetch = async (input, options) => {
	const request = new Request(input, options);
	const url = new URL(request.url);
	if (url.origin === issuer) {
		if (url.pathname === '/.well-known/openid-configuration')
			return json({
				issuer,
				authorization_endpoint: `${issuer}/oauth/authorize`,
				token_endpoint: `${issuer}/oauth/token`,
				userinfo_endpoint: `${issuer}/oauth/userinfo`,
				jwks_uri: `${issuer}/oauth/discovery/keys`,
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
				token_endpoint_auth_methods_supported: ['client_secret_post']
			});
		if (url.pathname === '/oauth/discovery/keys') return json({ keys: [key] });
		if (url.pathname === '/oauth/token') {
			const form = await request.formData();
			if (form.get('client_id') !== 'test-client' || form.get('client_secret') !== 'test-secret')
				return json({ error: 'invalid_client' }, 401);
			const { actor, nonce, fault } = JSON.parse(
				Buffer.from(String(form.get('code')), 'base64url').toString()
			);
			const info = {
				sub: `ident!${actor}`,
				name: `private legal name ${actor}`,
				email: `${actor}@example.com`,
				email_verified: actor !== 'email-unverified',
				slack_id: slackId(actor),
				verification_status: actor.startsWith('unverified') ? 'pending' : 'verified',
				ysws_eligible: actor !== 'adult'
			};
			identities.set(actor, info);
			const now = Math.floor(Date.now() / 1000);
			const payload = {
				...info,
				iss: issuer,
				aud: fault === 'audience' ? 'wrong-client' : 'test-client',
				iat: now,
				exp: fault === 'expired' ? now - 600 : now + 3600,
				nonce: fault === 'nonce' ? 'wrong-nonce' : nonce
			};
			const unsigned = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(payload)}`;
			const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
			return json({
				access_token: actor,
				token_type: 'Bearer',
				id_token: `${unsigned}.${fault === 'signature' ? `${signature.slice(0, -4)}xxxx` : signature}`
			});
		}
		if (url.pathname === '/oauth/userinfo')
			return json(identities.get(request.headers.get('authorization')?.replace('Bearer ', '')));
		throw new Error(`unexpected test oidc request: ${url.pathname}`);
	}
	if (url.origin === 'https://api.airtable.com') {
		const table = decodeURIComponent(url.pathname.split('/').at(-1));
		if (!['people', 'teams'].includes(table)) throw new Error('unexpected airtable table');
		if (request.method === 'PATCH') {
			for (const { fields } of (await request.json()).records) {
				let row = state[table].find((item) => item.id === fields.id);
				if (!row) {
					row = { id: fields.id };
					state[table].push(row);
				}
				Object.assign(row, fields);
			}
			persist();
			return json({ records: [] });
		}
		const expression = url.searchParams.get('filterByFormula');
		const match = /^\{(\w+)\}='((?:\\.|[^'])*)'$/.exec(expression || '');
		if (expression && !match) throw new Error(`unsupported fixture formula: ${expression}`);
		const value = match?.[2].replace(/\\(.)/g, '$1');
		const rows = match ? state[table].filter((item) => item[match[1]] === value) : state[table];
		const start = Number(url.searchParams.get('offset') || 0);
		const records = rows
			.slice(start, start + 100)
			.map((fields) => ({ id: `rec${fields.id}`, fields }));
		return json({ records, ...(rows.length > start + 100 ? { offset: String(start + 100) } : {}) });
	}
	if (url.origin === 'https://cachet.dunkirk.sh') {
		const actor = slackActors.get(url.pathname.split('/').at(-1));
		if (actor === 'cache-down') return json({}, 503);
		return json({
			displayName: actor === 'blank-name' ? '' : `${actor} on slack`,
			realName: 'private cachet real name',
			imageUrl: 'https://avatars.slack-edge.com/test.png'
		});
	}
	if (url.origin === 'https://hooks.slack.com') {
		const [, , channel, user] = url.pathname.split('/');
		const body = await request.json();
		if (request.headers.has('authorization') || body.response_type !== 'ephemeral')
			throw new Error('command replies must be private and must not forward the bot token');
		state.slack.push({ method: 'command.response', channel, user, text: body.text });
		persist();
		return new Response('ok');
	}
	if (url.origin === 'https://slack.com') {
		const method = url.pathname.split('/').at(-1);
		const body =
			request.method === 'GET' ? Object.fromEntries(url.searchParams) : await request.json();
		if (method === 'auth.test') return json({ ok: true, team_id: 'TTEST00001' });
		if (method === 'conversations.info') {
			if (request.method !== 'GET' || !body.channel)
				return json({ ok: false, error: 'invalid_arguments' });
			return json({
				ok: true,
				channel: {
					id: body.channel,
					name: body.channel === 'GPRIVATE01' ? 'private-hq' : 'team-hq',
					creator: slackId(
						body.channel === 'CRETRY0001'
							? 'retry-captain'
							: body.channel === 'CCREATOR01'
								? 'creator-captain'
								: ['CPUBLIC001', 'GPRIVATE01', 'CNOBOT0001'].includes(body.channel)
									? 'hq-captain'
									: body.channel === 'CUNKNOWN01'
										? 'no-slack'
										: 'other-creator'
					),
					is_member: body.channel !== 'CNOBOT0001',
					is_archived: false
				}
			});
		}
		if (method === 'conversations.invite' || method === 'chat.postEphemeral') {
			if (method === 'chat.postEphemeral' && body.channel === 'CNOBOT0001')
				return json({ ok: false, error: 'not_in_channel' });
			const previous = state.slack.filter(
				(row) => row.method === method && row.channel === body.channel && row.users === body.users
			).length;
			state.slack.push({ method, ...body });
			persist();
			if (method === 'conversations.invite' && body.channel === 'CRETRY0001' && previous === 0)
				return json({ ok: false, error: 'ratelimited' });
			if (method === 'conversations.invite' && previous > 0)
				return json({ ok: false, error: 'already_in_channel' });
			return json({ ok: true });
		}
		throw new Error(`unexpected test slack method: ${method}`);
	}
	// Fail closed: no accidental real messages or records from tests.
	if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')
		throw new Error('external network disabled in tests');
	return realFetch(input, options);
};
