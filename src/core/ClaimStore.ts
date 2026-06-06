import {TFile} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {Claim, Relation} from './types';

export class ClaimStore {
	constructor(private plugin: ExcerptManagerPlugin) {}

	private get vault() { return this.plugin.app.vault; }
	private get settings() { return this.plugin.settings; }

	async ensureFolder(): Promise<void> {
		const folder = this.settings.claimFolder;
		if (!this.vault.getAbstractFileByPath(folder)) {
			await this.vault.createFolder(folder);
		}
	}

	private generateId(label: string): string {
		const now = new Date();
		const pad = (n: number, len = 2) => String(n).padStart(len, '0');
		const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const slug = label.split(/\s+/).slice(0, 5)
			.join('-')
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '');
		return `claim-${date}-${time}-${slug}`;
	}

	async createClaim(label: string): Promise<Claim> {
		await this.ensureFolder();
		const id      = this.generateId(label);
		const created = new Date().toISOString();
		const claim: Claim = {id, label, created, tags: [], relations: []};
		await this.vault.create(
			`${this.settings.claimFolder}/${id}.md`,
			this.buildFrontmatter(claim) + `\n# ${label}\n`,
		);
		return claim;
	}

	async deleteClaim(id: string): Promise<void> {
		const excerpts = this.plugin.store.listExcerpts();
		const linked = excerpts.filter(e =>
			e.relations.some(r => r.target.split('/').pop() === id)
		);
		if (linked.length > 0) {
			throw new Error(`Cannot delete: ${linked.length} excerpt(s) are linked to this claim`);
		}

		const file = this.vault.getAbstractFileByPath(`${this.settings.claimFolder}/${id}.md`);
		if (!(file instanceof TFile)) throw new Error(`Claim not found: ${id}`);

		try {
			await this.vault.trash(file, false);
		} catch (err) {
			throw new Error(`Failed to delete claim: ${String(err)}`);
		}
	}

	readClaim(file: TFile): Claim | null {
		const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm['type'] !== 'claim') return null;

		const relations: Relation[] = Array.isArray(fm['relations'])
			? (fm['relations'] as Record<string, unknown>[]).map(r => ({
				type:   String(r['type']   ?? ''),
				target: String(r['target'] ?? '').replace(/^\[\[/, '').replace(/\]\]$/, ''),
				...(r['note']        !== undefined ? {note:      String(r['note'])}         : {}),
				...(r['rsl_link_id'] !== undefined ? {rslLinkId: Number(r['rsl_link_id'])}  : {}),
			}))
			: [];

		return {
			id:          String(fm['id']    ?? file.basename),
			label:       String(fm['label'] ?? file.basename),
			description: fm['description'] ? String(fm['description']) : undefined,
			created:     String(fm['created'] ?? ''),
			tags:        Array.isArray(fm['tags']) ? fm['tags'] as string[] : [],
			relations,
			...(fm['rsl_resource_id'] !== undefined ? {rslResourceId: Number(fm['rsl_resource_id'])} : {}),
			...(fm['rsl_selector_id'] !== undefined ? {rslSelectorId: Number(fm['rsl_selector_id'])} : {}),
		};
	}

	listClaims(): Claim[] {
		const folder = this.settings.claimFolder;
		return this.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(folder + '/'))
			.map(f => this.readClaim(f))
			.filter((c): c is Claim => c !== null)
			.sort((a, b) => b.created.localeCompare(a.created));
	}

	async updateLabel(claimId: string, newLabel: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(`${this.settings.claimFolder}/${claimId}.md`);
		if (!(file instanceof TFile)) throw new Error(`Claim not found: ${claimId}`);
		const claim = this.readClaim(file);
		if (!claim) throw new Error(`Could not read claim: ${claimId}`);
		const updated: Claim = {...claim, label: newLabel};
		const raw = await this.vault.read(file);
		const bodyStart = raw.indexOf('\n---\n', 3);
		const body = bodyStart !== -1 ? raw.slice(bodyStart + 5) : `\n# ${newLabel}\n`;
		await this.vault.modify(file, this.buildFrontmatter(updated) + body);
	}

	async updateRelations(claimId: string, relations: Relation[]): Promise<void> {
		const file = this.vault.getAbstractFileByPath(`${this.settings.claimFolder}/${claimId}.md`);
		if (!(file instanceof TFile)) throw new Error(`Claim not found: ${claimId}`);
		const claim = this.readClaim(file);
		if (!claim) throw new Error(`Could not read claim: ${claimId}`);
		const updated: Claim = {...claim, relations};
		// Preserve existing body (everything after the frontmatter)
		const raw = await this.vault.read(file);
		const bodyStart = raw.indexOf('\n---\n', 3);
		const body = bodyStart !== -1 ? raw.slice(bodyStart + 5) : `\n# ${claim.label}\n`;
		await this.vault.modify(file, this.buildFrontmatter(updated) + body);
	}

	async updateRslIds(claimId: string, rslResourceId: number, rslSelectorId: number): Promise<void> {
		const file = this.vault.getAbstractFileByPath(`${this.settings.claimFolder}/${claimId}.md`);
		if (!(file instanceof TFile)) throw new Error(`Claim not found: ${claimId}`);
		const claim = this.readClaim(file);
		if (!claim) throw new Error(`Could not read claim: ${claimId}`);
		const updated: Claim = {...claim, rslResourceId, rslSelectorId};
		const raw = await this.vault.read(file);
		const bodyStart = raw.indexOf('\n---\n', 3);
		const body = bodyStart !== -1 ? raw.slice(bodyStart + 5) : `\n# ${claim.label}\n`;
		await this.vault.modify(file, this.buildFrontmatter(updated) + body);
	}

	private buildFrontmatter(claim: Claim): string {
		const tagsYaml = claim.tags.length > 0
			? claim.tags.map(t => `  - ${t}`).join('\n')
			: '  []';
		const relationsYaml = claim.relations.length > 0
			? claim.relations.map(r =>
				`  - type: ${r.type}\n    target: "[[${r.target}]]"` +
				(r.note        ? `\n    note: "${r.note}"`                     : '') +
				(r.rslLinkId !== undefined ? `\n    rsl_link_id: ${r.rslLinkId}` : '')
			).join('\n')
			: '  []';
		const lines = [
			'---',
			'type: claim',
			`id: ${claim.id}`,
			`label: "${claim.label.replace(/"/g, '\\"')}"`,
			`created: ${claim.created}`,
			`tags:\n${tagsYaml}`,
			`relations:\n${relationsYaml}`,
		];
		if (claim.description) lines.push(`description: "${claim.description.replace(/"/g, '\\"')}"`);
		if (claim.rslResourceId !== undefined) lines.push(`rsl_resource_id: ${claim.rslResourceId}`);
		if (claim.rslSelectorId !== undefined) lines.push(`rsl_selector_id: ${claim.rslSelectorId}`);
		lines.push('---\n');
		return lines.join('\n');
	}
}
