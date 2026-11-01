<script lang="ts">
import SlackPerson from '#lib/SlackPerson.svelte';
import { enhance } from '$app/forms';
import type { PageProps } from './$types';

let { data, form }: PageProps = $props();
</script>

<svelte:head
	><title>Teams · HCAV</title>
	<meta name="robots" content="noindex"></svelte:head
>

<h1>Teams</h1>
<p>Most points first. Equal points share a rank.</p>
{#if form?.message}
	<p role="status">{form.message}</p>
{/if}
{#if data.currentTeamId}
	<p>You’re already on a team. <a href="/team">Go to your team</a>.</p>
{/if}
{#if data.teams.length}
	<ol class="pl-6">
		{#each data.teams as team}
			<li value={team.rank} class="my-4">
				<strong>{team.name}</strong>
				<span>· {team.points} {team.points === 1 ? 'point' : 'points'}</span>
				{#if team.id === data.currentTeamId}
					— your team
				{:else if team.open}
					— open registration
					{#if !data.currentTeamId}
						<form method="POST" use:enhance class="inline">
							<input type="hidden" name="team" value={team.id}>
							<button type="submit" aria-label={`Join ${team.name}`}>Join</button>
						</form>
					{/if}
				{:else}
					— invite-only
				{/if}
				{#if team.members.length}
					<ul aria-label={`People on ${team.name}`} class="pl-6">
						{#each team.members as member}
							<li class="my-2"><SlackPerson {...member} /></li>
						{/each}
					</ul>
				{:else}
					<p>No members yet.</p>
				{/if}
			</li>
		{/each}
	</ol>
{:else}
	<p>No teams yet. An unusually level playing field.</p>
{/if}
<p><a href="/team">Make your own team</a> if none of these people deserve you.</p>
