<script lang="ts">
import './layout.css';
import favicon from '#lib/assets/favicon.png';
import SlackPerson from '#lib/SlackPerson.svelte';
import { page } from '$app/state';
import type { LayoutProps } from './$types';

let { children, data }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon}>
	<meta name="theme-color" content="#ffffff">
</svelte:head>

{#if page.url.pathname !== '/'}
	<header class="mb-8">
		<nav aria-label="Main navigation" class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<a href="/">HCAV</a>
			<a href="/team">Your team</a>
			<a href="/teams">Teams</a>
			{#if data.user}
				<form method="POST" action="/auth/logout"><button type="submit">Sign out</button></form>
        <a href="https://hcav.hackclub.community/list.pdf">The List</a>
			{:else}
				<a href="/auth/login">Sign in</a>
			{/if}
		</nav>
		{#if data.user}
			<p>Signed in as <SlackPerson {...data.user} /></p>
		{/if}
	</header>
{/if}
<main id="main">{@render children()}</main>
