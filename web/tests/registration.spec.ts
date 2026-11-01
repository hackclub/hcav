import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test
} from '@playwright/test';

const app = 'http://localhost:5174';
const state = () =>
	JSON.parse(readFileSync('../.amp/in/test-providers.json', 'utf8')) as {
		people: { id: string; name: string; team_id?: string; slack_id: string }[];
		teams: {
			id: string;
			name: string;
			captain_id: string;
			link_token: string;
			open_registration?: boolean;
			hq_channel_id?: string;
		}[];
		slack: { method: string; channel: string; text?: string; users?: string; user?: string }[];
	};
const person = (actor: string) => {
	const value = state().people.find((person) => person.id === `ident!${actor}`);
	if (!value) throw new Error(`Missing person fixture: ${actor}`);
	return value;
};
const team = (actor: string) => {
	const value = state().teams.find((team) => team.captain_id === `ident!${actor}`);
	if (!value) throw new Error(`Missing team fixture: ${actor}`);
	return value;
};

async function signIn(request: APIRequestContext, actor: string, fault = '', next = '/team') {
	const start = await request.get(`/auth/login?next=${encodeURIComponent(next)}`, {
		maxRedirects: 0
	});
	expect(start.status()).toBe(303);
	const authorize = new URL(start.headers().location);
	expect(authorize.origin).toBe('https://auth.hackclub.com');
	expect(authorize.searchParams.get('scope')).toBe(
		'openid profile email slack_id verification_status'
	);
	const code = Buffer.from(
		JSON.stringify({ actor, nonce: authorize.searchParams.get('nonce'), fault })
	).toString('base64url');
	return request.get(
		`/auth/callback?${new URLSearchParams({ code, state: authorize.searchParams.get('state') || '' })}`,
		{ maxRedirects: 0 }
	);
}

const post = (request: APIRequestContext, form: Record<string, string>, path = '/team') =>
	request.post(path, { form, headers: { Origin: app, Accept: 'text/html' }, maxRedirects: 0 });
const create = (request: APIRequestContext, name: string) =>
	post(request, { action: 'create', name });
async function avatars(context: BrowserContext) {
	await context.route('https://avatars.slack-edge.com/**', (route) =>
		route.fulfill({
			contentType: 'image/png',
			body: Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
				'base64'
			)
		})
	);
}
async function actorContext(browser: Browser, actor: string) {
	const context = await browser.newContext({ baseURL: app });
	await avatars(context);
	expect((await signIn(context.request, actor)).status()).toBe(303);
	return context;
}
async function capture(page: Page, name: string) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: `../.amp/in/artifacts/${name}.png`, fullPage: true });
}

test('browser-default faq, registration, shared links and captain permissions', async ({
	page,
	context,
	browser
}) => {
	await avatars(context);
	await page.goto('about:blank');
	const font = await page.locator('body').evaluate((node) => getComputedStyle(node).fontFamily);
	await page.goto('/');
	await expect(page.getByRole('banner')).toHaveCount(0);
	await expect(page.locator('body')).toHaveCSS('font-family', font);
	await page.locator('summary').first().focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('details').first()).toHaveAttribute('open', '');
	await capture(page, 'landing-desktop');
	await page.setViewportSize({ width: 390, height: 844 });
	await capture(page, 'landing-mobile');
	expect((await context.request.get('/privacy')).status()).toBe(404);
	expect((await signIn(context.request, 'captain')).status()).toBe(303);
	await page.goto('/team');
	await expect(page.locator('body')).toHaveCSS('font-family', font);
	await capture(page, 'register-mobile');
	await page.setViewportSize({ width: 1280, height: 900 });
	await capture(page, 'register-desktop');
	await page.getByLabel('Team name', { exact: true }).fill('department of bad ideas');
	await page.getByRole('button', { name: 'Create team', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'department of bad ideas' })).toBeVisible();
	await expect(page.getByLabel('Open registration')).not.toBeChecked();
	const link = await page.getByLabel('Invite link', { exact: true }).inputValue();
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.getByRole('button', { name: 'Copy link' }).click();
	await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

	const member = await actorContext(browser, 'unverified-member');
	const memberPage = await member.newPage();
	await memberPage.goto(link);
	await capture(memberPage, 'invite-signed-in');
	await memberPage.getByRole('button', { name: 'Join this team' }).click();
	await expect(memberPage.getByRole('heading', { name: 'The team (2)' })).toBeVisible();
	for (const action of ['rename', 'registration', 'remove', 'transfer', 'rotate'])
		expect(
			(
				await post(member.request, {
					action,
					name: 'not allowed',
					member: 'ident!captain',
					open: 'on'
				})
			).status(),
			action
		).toBe(403);
	await capture(memberPage, 'team-member');
	await page.reload();
	await expect(
		page.getByRole('link', { name: 'captain on slack', exact: true }).first()
	).toBeVisible();
	expect(await page.content()).not.toContain('private legal name');
	expect(await page.content()).not.toContain('@example.com');
	await capture(page, 'team-desktop');
	await page.getByText('Other captain things', { exact: true }).click();
	await capture(page, 'team-settings');
	await page.setViewportSize({ width: 390, height: 844 });
	await capture(page, 'team-mobile');
	await page.getByLabel('Team name', { exact: true }).fill('department of worse ideas');
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('heading', { name: 'department of worse ideas' })).toBeVisible();
	expect((await post(context.request, { action: 'leave' })).status()).toBe(409);
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Make captain' }).click();
	await expect(page.getByLabel('Open registration')).toHaveCount(0);
	expect((await post(context.request, { action: 'rotate' })).status()).toBe(403);
	expect((await post(member.request, { action: 'remove', member: 'ident!captain' })).status()).toBe(
		200
	);
	expect(person('captain').team_id).toBe('');
	await member.close();
});

test('oidc validates tokens, requires linked slack, keeps public names private and enforces csrf/logout', async ({
	context,
	page,
	browser
}) => {
	await avatars(context);
	expect((await context.request.get('/auth/callback?state=bogus&code=bogus')).status()).toBe(400);
	for (const fault of ['nonce', 'signature', 'audience', 'expired'])
		expect((await signIn(context.request, 'invalid-login', fault)).status(), fault).toBe(400);
	expect(state().people.some((person) => person.id === 'ident!invalid-login')).toBe(false);
	expect((await signIn(context.request, 'no-slack')).status()).toBe(403);
	expect(
		(await signIn(context.request, 'logout-user', '', '//evil.example')).headers().location
	).toBe('/team');
	const session = (await context.cookies()).find((cookie) => cookie.name === 'hcav_session');
	if (!session) throw new Error('Missing session cookie');
	expect(session.httpOnly).toBe(true);
	expect(session.sameSite).toBe('Lax');
	for (const path of ['/team', '/teams', '/auth/logout', `/join/${'L'.repeat(43)}`]) {
		for (const headers of [{ Origin: 'https://evil.example' }, {}]) {
			const result = await context.request.post(path, {
				form: { action: 'create', name: 'forged', team: 'directory-0' },
				headers,
				maxRedirects: 0
			});
			expect(result.status(), path).toBe(403);
		}
	}
	await page.goto('/team');
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(`${app}/`);
	await context.addCookies([{ name: 'hcav_session', value: session.value, url: app }]);
	expect((await context.request.get('/team', { maxRedirects: 0 })).headers().location).toContain(
		'/auth/login'
	);

	for (const actor of ['cache-down', 'blank-name']) {
		const fallback = await actorContext(browser, actor);
		const html = await (await fallback.request.get('/team')).text();
		expect(html).toContain(person(actor).slack_id);
		expect(html).not.toContain('private legal name');
		expect(html).not.toContain('private cachet real name');
		await fallback.close();
	}
	const duplicate = await actorContext(browser, 'duplicate-a');
	expect((await signIn(context.request, 'duplicate-b')).status()).toBe(409);
	await duplicate.close();
});

test('directory is gated, ranked by points with shared ranks, and rechecks closed registration on join', async ({
	browser,
	request
}) => {
	const gated = await request.get('/teams', { maxRedirects: 0 });
	expect(gated.status()).toBe(303);
	expect(gated.headers().location).toContain('next=%2Fteams');
	const captain = await actorContext(browser, 'directory-captain');
	expect((await create(captain.request, 'the welcoming committee')).status()).toBe(200);
	const member = await actorContext(browser, 'directory-member');
	expect(
		(await post(member.request, {}, `/join/${team('directory-captain').link_token}`)).status()
	).toBe(303);
	const guest = await actorContext(browser, 'directory-guest');
	const page = await guest.newPage();
	await page.goto('/teams');
	await expect(page.locator('main > ol > li > strong').first()).toHaveText('directory team 4');
	expect((await page.locator('main > ol > li > strong').allTextContents()).slice(0, 4)).toEqual([
		'directory team 4',
		'directory team 2',
		'directory team 3',
		'directory team 1'
	]);
	for (const [index, label, rank] of [
		[0, '· 0 points', 5],
		[1, '· 1 point', 4],
		[2, '· 52 points', 2],
		[3, '· 52 points', 2],
		[4, '· 100 points', 1],
		[5, '· 0 points', 5]
	] as const) {
		const listing = page.locator('main > ol > li').filter({
			has: page.getByText(`directory team ${index}`, { exact: true })
		});
		await expect(listing.getByText(label, { exact: true })).toBeVisible();
		await expect(listing).toHaveAttribute('value', String(rank));
	}
	const roster = page.getByRole('list', { name: 'People on the welcoming committee', exact: true });
	await expect(roster.getByRole('listitem')).toHaveCount(2);
	await expect(roster.getByRole('link', { name: 'directory-captain on slack' })).toHaveAttribute(
		'href',
		`https://hackclub.enterprise.slack.com/team/${person('directory-captain').slack_id}`
	);
	await expect(roster.getByRole('link', { name: 'directory-member on slack' })).toBeVisible();
	await expect(roster.locator('img')).toHaveCount(2);
	await expect(roster.getByRole('link', { name: 'directory-guest on slack' })).toHaveCount(0);
	await expect(
		page
			.getByRole('list', { name: 'People on no maximum occupancy', exact: true })
			.getByRole('listitem')
	).toHaveCount(104);
	const html = await page.content();
	expect(html).not.toContain('link_token');
	expect(html).not.toContain(team('directory-captain').link_token);
	expect(html).not.toContain('@example.com');
	expect(html).not.toContain('private legal name');
	expect(html).not.toContain('private cachet real name');
	expect(
		(await post(guest.request, { team: team('directory-captain').id }, '/teams')).status()
	).toBe(403);
	const captainPage = await captain.newPage();
	await captainPage.goto('/team');
	await captainPage.getByLabel('Open registration').check();
	await captainPage.getByRole('button', { name: 'Save registration' }).click();
	await expect(captainPage.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Join the welcoming committee' })).toBeVisible();
	await capture(page, 'teams-desktop');
	await page.setViewportSize({ width: 390, height: 844 });
	await capture(page, 'teams-mobile');
	expect((await post(captain.request, { action: 'registration' })).status()).toBe(200);
	await page.getByRole('button', { name: 'Join the welcoming committee' }).click();
	await expect(page.getByRole('status')).toContainText('invite-only now');
	expect(person('directory-guest').team_id).toBeUndefined();
	const results = await Promise.all(
		['directory-0', 'directory-2'].map((id) => post(guest.request, { team: id }, '/teams'))
	);
	expect(results.map((result) => result.status()).sort()).toEqual([303, 409]);
	expect(['directory-0', 'directory-2']).toContain(person('directory-guest').team_id);
	await page.goto('/teams');
	await capture(page, 'teams-already-joined');
	await captain.close();
	await member.close();
	await guest.close();
});

test('only bearer invitations remain; links expire and rotate without removing members', async ({
	browser
}) => {
	const captain = await actorContext(browser, 'link-captain');
	expect((await create(captain.request, 'link team')).status()).toBe(200);
	const oldLink = `/join/${team('link-captain').link_token}`;
	const anonymous = await browser.newContext({ baseURL: app });
	const page = await anonymous.newPage();
	await page.goto(oldLink);
	await capture(page, 'invite-anonymous');
	await page.setViewportSize({ width: 390, height: 844 });
	await capture(page, 'invite-mobile');
	await expect(
		page.getByRole('link', { name: 'Sign in with Hack Club', exact: true })
	).toHaveAttribute('href', `/auth/login?next=${encodeURIComponent(oldLink)}`);
	expect((await signIn(anonymous.request, 'link-guest', '', oldLink)).headers().location).toBe(
		oldLink
	);
	expect((await post(anonymous.request, {}, oldLink)).status()).toBe(303);
	expect((await post(captain.request, { action: 'rotate' })).status()).toBe(200);
	expect((await anonymous.request.get(oldLink)).status()).toBe(410);
	expect(person('link-guest').team_id).toBe(team('link-captain').id);
	expect((await anonymous.request.get(`/join/${'E'.repeat(43)}`)).status()).toBe(410);
	expect((await anonymous.request.get(`/invite/${'A'.repeat(43)}`)).status()).toBe(404);
	expect(
		(
			await post(captain.request, {
				action: 'invite',
				channel: 'email',
				recipient: 'victim@example.com'
			})
		).status()
	).toBe(400);
	await page.goto(oldLink);
	await capture(page, 'expired-invite');
	await captain.close();
	await anonymous.close();
});

async function command(
	request: APIRequestContext,
	user: string,
	channel: string,
	options: {
		timestamp?: number;
		invalid?: boolean;
		workspace?: string;
		trigger?: string;
		responseUrl?: string;
	} = {}
) {
	const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
	const body = new URLSearchParams({
		command: '/hcav',
		text: 'hq',
		user_id: user,
		channel_id: channel,
		team_id: options.workspace || 'TTEST00001',
		response_url:
			options.responseUrl ?? `https://hooks.slack.com/commands/${channel}/${user}/test-response`,
		trigger_id: options.trigger || `${Date.now()}-${channel}`
	}).toString();
	const signature = `v0=${createHmac(
		'sha256',
		options.invalid ? 'wrong-secret' : 'test-signing-secret'
	)
		.update(`v0:${timestamp}:${body}`)
		.digest('hex')}`;
	return request.post('/slack/command', {
		data: body,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': signature
		},
		maxRedirects: 0
	});
}

test('signed slack hq commands enforce captain authority, deduplicate and add current and future members', async ({
	browser,
	request
}) => {
	const captain = await actorContext(browser, 'hq-captain');
	expect((await create(captain.request, 'the hq department')).status()).toBe(200);
	const guest = await actorContext(browser, 'hq-guest');
	expect((await post(guest.request, {}, `/join/${team('hq-captain').link_token}`)).status()).toBe(
		303
	);
	const user = person('hq-captain').slack_id;
	expect((await command(request, user, 'CPUBLIC001', { invalid: true })).status()).toBe(401);
	expect(
		(
			await command(request, user, 'CPUBLIC001', { timestamp: Math.floor(Date.now() / 1000) - 301 })
		).status()
	).toBe(401);
	expect((await command(request, user, 'CPUBLIC001', { workspace: 'TOTHER001' })).status()).toBe(
		403
	);
	for (const responseUrl of [
		'https://hooks.slack.com.evil.example/commands/test',
		'http://hooks.slack.com/commands/test',
		'https://hooks.slack.com/services/test'
	])
		expect((await command(request, user, 'CPUBLIC001', { responseUrl })).status()).toBe(400);
	expect((await command(request, person('hq-guest').slack_id, 'CPUBLIC001')).status()).toBe(200);
	await expect
		.poll(
			() =>
				state().slack.some(
					(row) =>
						row.method === 'command.response' &&
						row.user === person('hq-guest').slack_id &&
						row.text?.includes('Only your team captain')
				),
			{ timeout: 15_000 }
		)
		.toBe(true);
	expect(team('hq-captain').hq_channel_id).toBeUndefined();
	const replay = { timestamp: Math.floor(Date.now() / 1000), trigger: 'same-slack-delivery' };
	const started = Date.now();
	expect((await command(request, user, 'CPUBLIC001', replay)).status()).toBe(200);
	expect(Date.now() - started).toBeLessThan(3000);
	expect((await command(request, user, 'CPUBLIC001', replay)).status()).toBe(200);
	await expect.poll(() => team('hq-captain').hq_channel_id, { timeout: 15_000 }).toBe('CPUBLIC001');
	await expect
		.poll(
			() =>
				state().slack.filter(
					(row) => row.method === 'conversations.invite' && row.channel === 'CPUBLIC001'
				).length,
			{ timeout: 60_000 }
		)
		.toBe(2);
	expect(
		state().slack.filter(
			(row) =>
				row.method === 'command.response' && row.user === user && row.channel === 'CPUBLIC001'
		)
	).toHaveLength(1);
	const future = await actorContext(browser, 'hq-future');
	expect((await post(future.request, {}, `/join/${team('hq-captain').link_token}`)).status()).toBe(
		303
	);
	await expect
		.poll(
			() =>
				state().slack.some(
					(row) =>
						row.method === 'conversations.invite' &&
						row.channel === 'CPUBLIC001' &&
						row.users === person('hq-future').slack_id
				),
			{ timeout: 30_000 }
		)
		.toBe(true);
	for (const channel of ['C0BQ2GV0H0E', 'C0CB9NR1N3W'])
		expect(
			state().slack.some(
				(row) =>
					row.method === 'conversations.invite' && row.channel === channel && row.users === user
			)
		).toBe(true);
	expect((await command(request, user, 'GPRIVATE01')).status()).toBe(200);
	await expect.poll(() => team('hq-captain').hq_channel_id, { timeout: 15_000 }).toBe('GPRIVATE01');
	await expect
		.poll(
			() =>
				state().slack.filter(
					(row) => row.method === 'conversations.invite' && row.channel === 'GPRIVATE01'
				).length,
			{ timeout: 30_000 }
		)
		.toBe(3);
	const page = await captain.newPage();
	await page.goto('/team');
	await expect(page.getByRole('link', { name: '#private-hq', exact: true })).toBeVisible();
	await capture(page, 'team-hq');
	expect((await command(request, user, 'CNOBOT0001')).status()).toBe(200);
	await expect
		.poll(
			() =>
				state().slack.some(
					(row) =>
						row.method === 'command.response' &&
						row.channel === 'CNOBOT0001' &&
						row.text?.startsWith('Invite The Organization')
				),
			{ timeout: 15_000 }
		)
		.toBe(true);
	expect(team('hq-captain').hq_channel_id).toBe('GPRIVATE01');
	for (const context of [captain, guest, future]) await context.close();
});

test('hq requires the captain to be the channel creator', async ({ browser, request }) => {
	const captain = await actorContext(browser, 'creator-captain');
	expect((await create(captain.request, 'channel authority')).status()).toBe(200);
	const user = person('creator-captain').slack_id;
	expect((await command(request, user, 'CCREATOR01')).status()).toBe(200);
	await expect
		.poll(() => team('creator-captain').hq_channel_id, { timeout: 15_000 })
		.toBe('CCREATOR01');
	for (const channel of ['COTHER0001', 'CUNKNOWN01']) {
		expect((await command(request, user, channel)).status()).toBe(200);
		await expect
			.poll(
				() =>
					state().slack.some(
						(row) =>
							row.method === 'command.response' &&
							row.channel === channel &&
							row.user === user &&
							row.text === 'You must have created this Slack channel to set it as HQ.'
					),
				{ timeout: 15_000 }
			)
			.toBe(true);
		expect(team('creator-captain').hq_channel_id).toBe('CCREATOR01');
		expect(
			state().slack.some((row) => row.method === 'conversations.invite' && row.channel === channel)
		).toBe(false);
	}
	await captain.close();
});

test('channel failures preserve team membership and can be retried without sending dms', async ({
	browser,
	request
}) => {
	const captain = await actorContext(browser, 'retry-captain');
	expect((await create(captain.request, 'retry team')).status()).toBe(200);
	expect((await command(request, person('retry-captain').slack_id, 'CRETRY0001')).status()).toBe(
		200
	);
	const page = await captain.newPage();
	await expect
		.poll(
			async () => {
				await page.goto('/team');
				await page.getByText('Slack channel status', { exact: true }).click();
				return page.locator('main').innerText();
			},
			{ timeout: 30_000, intervals: [1500] }
		)
		.toContain('ratelimited');
	expect(person('retry-captain').team_id).toBe(team('retry-captain').id);
	await capture(page, 'channel-failure');
	await page.getByRole('button', { name: 'Retry channel additions' }).click();
	await expect(page.getByRole('status')).toContainText('queued');
	await expect
		.poll(
			async () => {
				await page.reload();
				const details = page
					.locator('details')
					.filter({ has: page.getByText('Slack channel status', { exact: true }) });
				await details.evaluate((node) => {
					(node as HTMLDetailsElement).open = true;
				});
				return details.innerText();
			},
			{ timeout: 30_000, intervals: [1500] }
		)
		.toContain('#team hq: added');
	expect((await post(captain.request, { action: 'retry-channels' })).status()).toBe(429);
	await capture(page, 'channel-recovered');
	expect(
		state().slack.every((row) =>
			['conversations.invite', 'chat.postEphemeral', 'command.response'].includes(row.method)
		)
	).toBe(true);
	await captain.close();
});

test('teams span airtable pages without exposing member emails or legal names', async ({
	browser
}) => {
	const context = await actorContext(browser, 'large-newcomer');
	expect((await post(context.request, {}, `/join/${'L'.repeat(43)}`)).status()).toBe(303);
	const page = await context.newPage();
	await page.goto('/team');
	await expect(page.getByRole('heading', { name: 'The team (105)' })).toBeVisible();
	await expect(page.getByText('large member 103 on slack', { exact: true })).toBeVisible();
	expect(await page.content()).not.toContain('private-member-103@example.com');
	expect(await page.content()).not.toContain('private legal name');
	await context.close();
});
