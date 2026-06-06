import {Notice, TFile} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {RslApiClient} from './RslApiClient';
import {Claim, Excerpt, Paper, Relation} from './types';

export class RslSyncService {
	constructor(
		public readonly api: RslApiClient,
		private plugin: ExcerptManagerPlugin,
	) {}

	get enabled(): boolean {
		return this.plugin.settings.rslSyncEnabled;
	}

	// ─── Push: local → RSL ────────────────────────────────────────────────────

	async pushPaper(paper: Paper): Promise<void> {
		if (!this.enabled) return;
		console.log(`[RSL] pushPaper: ${paper.id} (rslResourceId=${paper.rslResourceId})`);
		try {
			const pdfFile = this.plugin.app.vault.getAbstractFileByPath(paper.pdfPath);
			if (!(pdfFile instanceof TFile)) {
				new Notice(`RSL sync: PDF not found in vault — ${paper.pdfPath}`);
				return;
			}

			const buffer  = await this.plugin.app.vault.readBinary(pdfFile);
			const author  = paper.authors.join(', ') || 'Unknown';
			const title   = paper.title || pdfFile.basename;
			const year    = paper.year !== undefined ? String(paper.year) : 'unknown';

			console.log(`[RSL] createResource fields — author:"${author}" title:"${title}" year:"${year}" file:${pdfFile.name} size:${buffer.byteLength}`);
			if (paper.rslResourceId === undefined) {
				const result = await this.api.createResource(buffer, pdfFile.name, author, title, year);
				await this.plugin.paperStore.updateRslResourceId(paper.id, result.id);
			} else {
				await this.api.updateResource(paper.rslResourceId, buffer, author, title, year);
			}
		} catch (e) {
			const msg = String(e);
			if (msg.includes('413')) {
				new Notice(`RSL: "${paper.title}" is too large for the server (413). Skipping.`);
			} else {
				console.error(`[RSL] pushPaper failed for ${paper.id}:`, e);
				new Notice(`RSL sync failed (paper): ${msg}`);
			}
		}
	}

	async pushExcerpt(excerpt: Excerpt): Promise<void> {
		if (!this.enabled) return;
		console.log(`[RSL] pushExcerpt: ${excerpt.id} source="${excerpt.source}" rslSelectorId=${excerpt.rslSelectorId}`);
		try {
			// source may be "papers/slug" — try with and without .md
			const paperFile = this.plugin.app.vault.getAbstractFileByPath(excerpt.source + '.md')
				?? this.plugin.app.vault.getAbstractFileByPath(excerpt.source);
			console.log(`[RSL] paperFile resolved:`, paperFile?.path ?? 'NOT FOUND');
			let referent: number | undefined;

			if (paperFile instanceof TFile) {
				const paper = this.plugin.paperStore.readPaper(paperFile);
				console.log(`[RSL] paper:`, paper?.id, 'rslResourceId=', paper?.rslResourceId);
				if (paper) {
					if (paper.rslResourceId === undefined) await this.pushPaper(paper);
					const refreshed = this.plugin.paperStore.readPaper(paperFile);
					referent = refreshed?.rslResourceId;
					console.log(`[RSL] referent after push:`, referent);
				}
			}

			if (referent === undefined) {
				console.warn(`[RSL] skipping excerpt ${excerpt.id} — no referent`);
				new Notice(`RSL sync: Cannot push excerpt "${excerpt.label}" — paper has no RSL resource ID`);
				return;
			}

			// Server requires each rect to be exactly [x, y, w, h] — 4 numbers, no more
			const rawRects = excerpt.selectionRects ?? [];
			const rects: number[][] = rawRects
				.map(r => r.slice(0, 4).map(Number).filter(n => !isNaN(n)))
				.filter(r => r.length === 4);
			const safeRects = rects.length > 0 ? rects : [[0, 0, 1, 1]];
			console.log(`[RSL] createSelector referent=${referent} page=${excerpt.page} rects=`, JSON.stringify(safeRects));

			if (excerpt.rslSelectorId === undefined) {
				const result = await this.api.createSelector(referent, excerpt.page, safeRects);
				await this.plugin.store.updateRslSelectorId(excerpt.id, result.id);
			} else {
				await this.api.updateSelector(excerpt.rslSelectorId, excerpt.page, safeRects);
			}
		} catch (e) {
			console.error(`[RSL] pushExcerpt failed for ${excerpt.id}:`, String(e));
			new Notice(`RSL sync failed (excerpt ${excerpt.id}): ${String(e)}`);
		}
	}

	async pushClaim(claim: Claim): Promise<void> {
		if (!this.enabled) return;
		console.log(`[RSL] pushClaim: ${claim.id} (rslResourceId=${claim.rslResourceId})`);
		try {
			const pdfBuffer = RslSyncService.buildMinimalPdf();
			const filename  = `claim-${claim.id}.pdf`;

			let rslResourceId: number;
			if (claim.rslResourceId === undefined) {
				const result = await this.api.createResource(pdfBuffer, filename, '__claim__', claim.label, 'unknown');
				rslResourceId = result.id;
			} else {
				rslResourceId = claim.rslResourceId;
			}

			let rslSelectorId: number;
			if (claim.rslSelectorId === undefined || claim.rslSelectorId === 0) {
				const result = await this.api.createSelector(rslResourceId, 1, [[0, 0, 1, 1]]);
				rslSelectorId = result.id;
			} else {
				rslSelectorId = claim.rslSelectorId;
			}

			await this.plugin.claimStore.updateRslIds(claim.id, rslResourceId, rslSelectorId);
			console.log(`[RSL] pushClaim done: rslResourceId=${rslResourceId} rslSelectorId=${rslSelectorId}`);
		} catch (e) {
			console.error(`[RSL] pushClaim failed for ${claim.id}:`, e);
			new Notice(`RSL sync failed (claim): ${String(e)}`);
		}
	}

	async pushRelation(excerptId: string, relation: Relation): Promise<void> {
		if (!this.enabled) return;
		try {
			const {excerptFolder, claimFolder} = this.plugin.settings;
			const srcFile = this.plugin.app.vault.getAbstractFileByPath(`${excerptFolder}/${excerptId}.md`);
			if (!(srcFile instanceof TFile)) { console.warn(`[RSL] pushRelation: src file not found ${excerptId}`); return; }
			const srcExcerpt = this.plugin.store.readExcerpt(srcFile);
			if (!srcExcerpt?.rslSelectorId) { console.warn(`[RSL] pushRelation: src has no rslSelectorId — ${excerptId}`); return; }

			const targetId = relation.target.split('/').pop() ?? '';

			// Resolve target selector ID — could be an excerpt or a claim
			let tgtSelectorId: number | undefined;
			const tgtExcerptFile = this.plugin.app.vault.getAbstractFileByPath(`${excerptFolder}/${targetId}.md`);
			if (tgtExcerptFile instanceof TFile) {
				tgtSelectorId = this.plugin.store.readExcerpt(tgtExcerptFile)?.rslSelectorId;
				if (!tgtSelectorId) { console.warn(`[RSL] pushRelation: tgt excerpt has no rslSelectorId — ${targetId}`); return; }
			} else {
				const tgtClaimFile = this.plugin.app.vault.getAbstractFileByPath(`${claimFolder}/${targetId}.md`);
				if (tgtClaimFile instanceof TFile) {
					tgtSelectorId = this.plugin.claimStore.readClaim(tgtClaimFile)?.rslSelectorId;
					if (!tgtSelectorId) { console.warn(`[RSL] pushRelation: tgt claim has no rslSelectorId — ${targetId}`); return; }
				}
			}
			if (!tgtSelectorId) { console.warn(`[RSL] pushRelation: tgt not found — ${targetId}`); return; }

			console.log(`[RSL] createLink src=${srcExcerpt.rslSelectorId} tgt=${tgtSelectorId} type=${relation.type}`);

			if (relation.rslLinkId === undefined) {
				const result = await this.api.createLink(srcExcerpt.rslSelectorId, tgtSelectorId, relation.type);
				const updatedRelations = srcExcerpt.relations.map(r =>
					r.type === relation.type && r.target === relation.target
						? {...r, rslLinkId: result.id}
						: r,
				);
				await this.plugin.store.updateRelations(excerptId, updatedRelations);
			}
		} catch (e) {
			new Notice(`RSL sync failed (relation): ${String(e)}`);
		}
	}

	async pushAll(): Promise<{papers: number; claims: number; excerpts: number; links: number; failed: number}> {
		let papers = 0, claims = 0, excerpts = 0, links = 0, failed = 0;
		const paperList   = this.plugin.paperStore.listPapers();
		const claimList   = this.plugin.claimStore.listClaims();
		const excerptList = this.plugin.store.listExcerpts();

		console.log(`[RSL] pushAll — ${paperList.length} papers, ${claimList.length} claims, ${excerptList.length} excerpts`);

		// Pass 1: push all papers
		for (const paper of paperList) {
			try { await this.pushPaper(paper); papers++; }
			catch (e) { failed++; console.error(`[RSL] pushPaper failed (${paper.id}):`, e); }
		}

		// Pass 2: push all claims
		for (const claim of claimList) {
			try { await this.pushClaim(claim); claims++; }
			catch (e) { failed++; console.error(`[RSL] pushClaim failed (${claim.id}):`, e); }
		}

		// Pass 3: push all excerpts
		for (const excerpt of excerptList) {
			try { await this.pushExcerpt(excerpt); excerpts++; }
			catch (e) { failed++; console.error(`[RSL] pushExcerpt failed (${excerpt.id}):`, e); }
		}

		// Pass 4: push all relations
		const freshExcerpts = this.plugin.store.listExcerpts();
		for (const excerpt of freshExcerpts) {
			for (const rel of excerpt.relations) {
				try {
					console.log(`[RSL] pushRelation: ${excerpt.id} → ${rel.target} (type=${rel.type})`);
					await this.pushRelation(excerpt.id, rel);
					links++;
				} catch (e) { failed++; console.error(`[RSL] pushRelation failed:`, e); }
			}
		}

		return {papers, claims, excerpts, links, failed};
	}

	// ─── Pull: RSL → local ────────────────────────────────────────────────────

	async pullAll(): Promise<{papers: number; claims: number; excerpts: number; links: number; failed: number}> {
		let papers = 0, claims = 0, excerpts = 0, links = 0, failed = 0;

		// Fetch all three collections flat, in parallel
		const [resources, selectors, rslLinks] = await Promise.all([
			this.api.fetchResources(),
			this.api.fetchSelectors(),
			this.api.fetchLinks(),
		]);

		console.log(`[RSL] pullAll — ${resources.length} resources, ${selectors.length} selectors, ${rslLinks.length} links`);
		console.log(`[RSL] resource IDs:`, resources.map(r => r.id));
		console.log(`[RSL] selector referents:`, selectors.map(s => `sel${s.id}→ref${s.referent}`));

		// Group selectors by referent
		const selectorsByResource = new Map<number, typeof selectors>();
		for (const sel of selectors) {
			const group = selectorsByResource.get(sel.referent) ?? [];
			group.push(sel);
			selectorsByResource.set(sel.referent, group);
		}

		// Separate claim resources (author === '__claim__') from paper resources
		const isClaimResource = (raw: Record<string, unknown>) => {
			const meta = (raw['resource/metadata'] ?? {}) as Record<string, unknown>;
			const author = RslApiClient.extractStr(meta, ['author']) ?? RslApiClient.extractStr(raw, ['author']) ?? '';
			return author === '__claim__';
		};

		// Process claim resources
		for (const resource of resources) {
			if (!isClaimResource(resource.raw)) continue;
			try {
				const claimSelectors = selectorsByResource.get(resource.id) ?? [];
				const dummySel = claimSelectors[0];
				await this.ensureLocalClaim(resource.id, resource.raw, dummySel?.id);
				claims++;
			} catch (e) { failed++; console.error(`[RSL] ensureLocalClaim failed (resource ${resource.id}):`, e); }
		}

		// Process paper resources
		for (const resource of resources) {
			if (isClaimResource(resource.raw)) continue;
			try {
				await this.ensureLocalPaper(resource.id, resource.raw);
				papers++;
			} catch (e) { failed++; console.error(`[RSL] ensureLocalPaper failed (resource ${resource.id}):`, e); }

			const resourceSelectors = selectorsByResource.get(resource.id) ?? [];
			console.log(`[RSL] resource ${resource.id} → ${resourceSelectors.length} selectors`);
			for (const sel of resourceSelectors) {
				try {
					await this.ensureLocalExcerpt(sel.raw, resource.id);
					excerpts++;
				} catch (e) { failed++; console.error(`[RSL] ensureLocalExcerpt failed (resource ${resource.id}):`, e); }
			}
		}

		// Process any selectors whose referent resource wasn't in the resources list
		const knownResourceIds = new Set(resources.map(r => r.id));
		for (const sel of selectors) {
			if (!knownResourceIds.has(sel.referent)) {
				console.log(`[RSL] orphaned selector ${sel.id} — referent ${sel.referent} not in resources list, processing anyway`);
				try {
					await this.ensureLocalExcerpt(sel.raw, sel.referent);
					excerpts++;
				} catch (e) { failed++; console.error(`[RSL] ensureLocalExcerpt (orphan) failed:`, e); }
			}
		}

		// Wire up links between excerpts (and from excerpts to claims)
		const allExcerpts = this.plugin.store.listExcerpts();
		for (const lk of rslLinks) {
			const srcExcerpt = allExcerpts.find(e => e.rslSelectorId === lk.source);
			if (!srcExcerpt) { console.warn(`[RSL] no local excerpt for link source selectorId=${lk.source}`); continue; }
			try {
				await this.ensureLocalRelation(srcExcerpt, lk.raw);
				links++;
			} catch (e) { failed++; console.error(`[RSL] ensureLocalRelation failed:`, e); }
		}

		// Final pass: fill in real text for any excerpts still showing placeholder
		try { await this.repairExcerptTexts(); }
		catch (e) { console.error(`[RSL] repairExcerptTexts failed:`, e); }

		return {papers, claims, excerpts, links, failed};
	}

	// ─── Repair: fill placeholder excerpt texts from local PDFs ─────────────

	async repairExcerptTexts(): Promise<number> {
		const placeholders = this.plugin.store.listExcerpts()
			.filter(e => !e.selectionText || e.selectionText.startsWith('[synced from RSL'));

		console.log(`[RSL] repairExcerptTexts — ${placeholders.length} excerpts need text`);
		let fixed = 0;

		for (const excerpt of placeholders) {
			if (!excerpt.selectionRects || excerpt.selectionRects.length === 0) continue;

			// Find the paper via the excerpt's source path directly — no RSL IDs needed
			const paperFile = this.plugin.app.vault.getAbstractFileByPath(excerpt.source + '.md')
				?? this.plugin.app.vault.getAbstractFileByPath(excerpt.source);
			if (!(paperFile instanceof TFile)) {
				console.warn(`[RSL] repair: paper file not found for source "${excerpt.source}"`);
				continue;
			}

			const paper = this.plugin.paperStore.readPaper(paperFile);
			if (!paper?.pdfPath) {
				console.warn(`[RSL] repair: no pdfPath on paper ${paperFile.path}`);
				continue;
			}

			const pdfInVault = this.plugin.app.vault.getAbstractFileByPath(paper.pdfPath);
			if (!pdfInVault) {
				console.warn(`[RSL] repair: PDF not in vault at "${paper.pdfPath}"`);
				continue;
			}

			try {
				const {text, selectionRange} = await this.extractTextFromRects(paper.pdfPath, excerpt.page, excerpt.selectionRects);
				if (!text) { console.warn(`[RSL] repair: no text extracted for ${excerpt.id}`); continue; }

				const label = text.slice(0, 80).replace(/\s+/g, ' ').trim();
				await this.plugin.store.updateExcerpt(excerpt.id, {
					...excerpt,
					label,
					selectionText: text,
					selectionRange: selectionRange || undefined,
				});
				console.log(`[RSL] repair: updated ${excerpt.id} — "${text.slice(0, 60)}" range="${selectionRange}"`);
				fixed++;
			} catch (e) {
				console.warn(`[RSL] repair failed for ${excerpt.id}:`, e);
			}
		}

		console.log(`[RSL] repairExcerptTexts done — fixed ${fixed}/${placeholders.length}`);
		return fixed;
	}

	// ─── Delete: remove from RSL ──────────────────────────────────────────────

	async deleteRemotePaper(rslResourceId: number): Promise<void> {
		try { await this.api.deleteResource(rslResourceId); } catch (e) { new Notice(`RSL delete failed: ${String(e)}`); }
	}

	async deleteRemoteExcerpt(rslSelectorId: number): Promise<void> {
		try { await this.api.deleteSelector(rslSelectorId); } catch (e) { new Notice(`RSL delete failed: ${String(e)}`); }
	}

	async deleteRemoteRelation(rslLinkId: number): Promise<void> {
		try { await this.api.deleteLink(rslLinkId); } catch (e) { new Notice(`RSL delete failed: ${String(e)}`); }
	}

	// ─── Pull helpers ─────────────────────────────────────────────────────────

	private async ensureLocalPaper(rslId: number, raw: Record<string, unknown>): Promise<void> {
		const existing = this.plugin.paperStore.listPapers().find(p => p.rslResourceId === rslId);
		if (existing) { console.log(`[RSL] paper already exists: ${existing.id}`); return; }

		const meta   = (raw['resource/metadata'] ?? {}) as Record<string, unknown>;
		const title  = RslApiClient.extractStr(meta, ['title', 'name'])
			?? RslApiClient.extractStr(raw, ['title', 'name'])
			?? `RSL Resource ${rslId}`;
		const author = RslApiClient.extractStr(meta, ['author'])
			?? RslApiClient.extractStr(raw, ['author'])
			?? '';
		const yearStr = RslApiClient.extractStr(meta, ['year']) ?? RslApiClient.extractStr(raw, ['year']);
		const year   = yearStr && yearStr !== 'unknown' ? Number(yearStr) : undefined;
		console.log(`[RSL] ensureLocalPaper rslId=${rslId} title="${title}" author="${author}" year=${year}`);

		// Attempt to download PDF
		let pdfPath = `pdfs/rsl-resource-${rslId}.pdf`;
		try {
			const fileBytes = await this.api.getEntityFile(rslId);
			const pdfFolder = 'pdfs';
			if (!this.plugin.app.vault.getAbstractFileByPath(pdfFolder)) {
				await this.plugin.app.vault.createFolder(pdfFolder);
			}
			await this.plugin.app.vault.createBinary(pdfPath, fileBytes);
		} catch {
			pdfPath = ''; // PDF unavailable — create paper note without it
		}

		const slug     = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const filePath = `${this.plugin.settings.paperFolder}/${slug}.md`;
		const authors  = author ? [author] : [];

		const note = this.buildPaperNote({id: slug, title, authors, year, pdfPath, rslResourceId: rslId});
		try {
			if (!this.plugin.app.vault.getAbstractFileByPath(filePath)) {
				await this.plugin.app.vault.create(filePath, note);
			}
		} catch {
			// File may already exist with the same name — ignore
		}
	}

	private async ensureLocalExcerpt(sel: Record<string, unknown>, rslResourceId: number): Promise<void> {
		const rslSelectorId = RslApiClient.extractId(sel);
		console.log(`[RSL] ensureLocalExcerpt selectorId=${rslSelectorId} resourceId=${rslResourceId}`);
		if (!rslSelectorId) { console.warn('[RSL] no selectorId, skipping'); return; }

		const existing = this.plugin.store.listExcerpts().find(e => e.rslSelectorId === rslSelectorId);
		// If it exists with real text already, skip
		if (existing && existing.selectionText && !existing.selectionText.startsWith('[synced from RSL')) {
			console.log(`[RSL] excerpt already exists with text: ${existing.id}`);
			return;
		}

		const pointer = (sel['pointer'] ?? sel['selector/pointer']) as Record<string, unknown> | undefined;
		const page    = pointer ? Number(pointer['page'] ?? 1) : 1;
		const rects   = Array.isArray(pointer?.['rects']) ? pointer!['rects'] as number[][] : [];

		// Find local paper — try rslResourceId first, then fall back to any paper whose PDF exists
		const allPapers = this.plugin.paperStore.listPapers();
		const paper = allPapers.find(p => p.rslResourceId === rslResourceId)
			?? allPapers.find(p => p.pdfPath && this.plugin.app.vault.getAbstractFileByPath(p.pdfPath));
		console.log(`[RSL] matched paper:`, paper?.id ?? 'none', 'pdfPath=', paper?.pdfPath ?? 'none');
		const source = paper
			? `${this.plugin.settings.paperFolder}/${paper.id}`
			: `${this.plugin.settings.paperFolder}/rsl-resource-${rslResourceId}`;

		// Try to extract text and selection range from the PDF using the stored rects
		let selectionText = '';
		let selectionRange: string | undefined;
		console.log(`[RSL] paper pdfPath="${paper?.pdfPath}" rects=`, JSON.stringify(rects));
		if (paper?.pdfPath) {
			const pdfFile = this.plugin.app.vault.getAbstractFileByPath(paper.pdfPath);
			console.log(`[RSL] pdfFile in vault:`, pdfFile ? pdfFile.path : 'NOT FOUND');
			try {
				const result = await this.extractTextFromRects(paper.pdfPath, page, rects);
				selectionText  = result.text;
				selectionRange = result.selectionRange || undefined;
				console.log(`[RSL] extracted text: "${selectionText.slice(0, 100)}" range="${selectionRange}"`);
			} catch (e) {
				console.warn('[RSL] text extraction failed:', e);
			}
		} else {
			console.warn('[RSL] no pdfPath on paper — cannot extract text');
		}

		const label = selectionText ? selectionText.slice(0, 80).replace(/\s+/g, ' ').trim() : `Excerpt from page ${page}`;
		const text  = selectionText || '[synced from RSL — open PDF to view]';

		if (existing) {
			await this.plugin.store.updateExcerpt(existing.id, {
				...existing,
				label,
				selectionText: text,
				selectionRange,
				selectionRects: rects,
			});
		} else {
			await this.plugin.store.createExcerpt({
				label,
				source,
				page,
				selectionText: text,
				selectionRange,
				selectionRects: rects,
				tags: [],
				relations: [],
				rslSelectorId,
			});
		}
	}

	private async extractTextFromRects(pdfPath: string, page: number, rects: number[][]): Promise<{text: string; selectionRange: string}> {
		const pdfjsLib = (window as unknown as Record<string, unknown>)['pdfjsLib'] as {
			getDocument: (opts: {data: ArrayBuffer}) => {promise: Promise<{
				getPage: (n: number) => Promise<{
					getViewport: (opts: {scale: number}) => {width: number; height: number};
					getTextContent: () => Promise<{items: {str: string; transform: number[]; width: number; height: number}[]}>;
				}>;
			}>};
		} | undefined;
		if (!pdfjsLib?.getDocument) return {text: '', selectionRange: ''};

		const pdfFile = this.plugin.app.vault.getAbstractFileByPath(pdfPath);
		if (!(pdfFile instanceof TFile)) return {text: '', selectionRange: ''};

		const data    = await this.plugin.app.vault.readBinary(pdfFile);
		const pdf     = await pdfjsLib.getDocument({data}).promise;
		const pdfPage = await pdf.getPage(page);
		const viewport = pdfPage.getViewport({scale: 1});
		const W = viewport.width, H = viewport.height;

		const textContent = await pdfPage.getTextContent();
		const words: string[] = [];
		let firstIdx = -1, lastIdx = -1;

		textContent.items.forEach((item, idx) => {
			const t  = item.transform as number[];
			const t3 = t[3] as number | undefined ?? 0;
			const t4 = t[4] as number | undefined ?? 0;
			const t5 = t[5] as number | undefined ?? 0;
			const tx = t4 / W;
			const ty = 1 - t5 / H;
			const iw = (item.width as number) / W;
			const ih = Math.abs((item.height as number) || t3) / H;

			const overlaps = rects.some(r => {
				const rx = r[0] ?? 0, ry = r[1] ?? 0, rw = r[2] ?? 0, rh = r[3] ?? 0;
				return tx < rx + rw && tx + iw > rx && ty < ry + rh && ty + ih > ry;
			});

			if (overlaps && (item.str as string).trim()) {
				words.push(item.str as string);
				if (firstIdx === -1) firstIdx = idx;
				lastIdx = idx;
			}
		});

		const text = words.join(' ').replace(/\s+/g, ' ').trim();

		// selectionRange format: "startIdx,startOffset,endIdx,endOffset"
		// Used by PdfNavigator to restore the text highlight overlay
		const lastItem = textContent.items[lastIdx];
		const endOffset = lastItem ? (lastItem.str as string).length : 0;
		const selectionRange = firstIdx >= 0
			? `${firstIdx},0,${lastIdx},${endOffset}`
			: '';

		return {text, selectionRange};
	}

	private async ensureLocalClaim(rslId: number, raw: Record<string, unknown>, dummySelectorId?: number): Promise<void> {
		const existing = this.plugin.claimStore.listClaims().find(c => c.rslResourceId === rslId);
		if (existing) {
			// Update dummy selector ID if not yet stored
			if (dummySelectorId !== undefined && (!existing.rslSelectorId || existing.rslSelectorId === 0)) {
				await this.plugin.claimStore.updateRslIds(existing.id, rslId, dummySelectorId);
			}
			console.log(`[RSL] claim already exists: ${existing.id}`);
			return;
		}

		const meta  = (raw['resource/metadata'] ?? {}) as Record<string, unknown>;
		const label = RslApiClient.extractStr(meta, ['title', 'name'])
			?? RslApiClient.extractStr(raw, ['title', 'name'])
			?? `Claim ${rslId}`;
		console.log(`[RSL] ensureLocalClaim rslId=${rslId} label="${label}" dummySelectorId=${dummySelectorId}`);

		const claim = await this.plugin.claimStore.createClaim(label);
		await this.plugin.claimStore.updateRslIds(claim.id, rslId, dummySelectorId ?? 0);
	}

	private async ensureLocalRelation(srcExcerpt: Excerpt, link: Record<string, unknown>): Promise<void> {
		const rslLinkId   = Number(link['id']);
		const targetSelId = Number(link['target']);
		if (!rslLinkId || !targetSelId) return;

		// Already wired?
		if (srcExcerpt.relations.some(r => r.rslLinkId === rslLinkId)) return;

		// Check if target is an excerpt or a claim
		const tgtExcerpt = this.plugin.store.listExcerpts().find(e => e.rslSelectorId === targetSelId);
		let targetPath: string;
		if (tgtExcerpt) {
			targetPath = `${this.plugin.settings.excerptFolder}/${tgtExcerpt.id}`;
		} else {
			const tgtClaim = this.plugin.claimStore.listClaims().find(c => c.rslSelectorId === targetSelId);
			if (!tgtClaim) return;
			targetPath = `${this.plugin.settings.claimFolder}/${tgtClaim.id}`;
		}

		const property = String(link['property'] ?? 'related-to');
		const newRel: Relation = {type: property, target: targetPath, rslLinkId};

		await this.plugin.store.updateRelations(srcExcerpt.id, [...srcExcerpt.relations, newRel]);
	}

	// ─── Minimal PDF builder ──────────────────────────────────────────────────

	private static buildMinimalPdf(): ArrayBuffer {
		const enc = new TextEncoder();
		const parts: Uint8Array[] = [];
		let offset = 0;

		const push = (s: string) => {
			const b = enc.encode(s);
			parts.push(b);
			offset += b.length;
			return b.length;
		};

		push('%PDF-1.4\n');

		const off1 = offset;
		push('1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n');

		const off2 = offset;
		push('2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n');

		const off3 = offset;
		push('3 0 obj\n<</Type /Page /MediaBox [0 0 1 1] /Parent 2 0 R>>\nendobj\n');

		const xrefOffset = offset;
		const pad = (n: number) => String(n).padStart(10, '0');
		push(
			'xref\n0 4\n' +
			`0000000000 65535 f \n` +
			`${pad(off1)} 00000 n \n` +
			`${pad(off2)} 00000 n \n` +
			`${pad(off3)} 00000 n \n` +
			'trailer\n<</Size 4 /Root 1 0 R>>\n' +
			`startxref\n${xrefOffset}\n%%EOF\n`,
		);

		const total  = parts.reduce((s, p) => s + p.length, 0);
		const result = new Uint8Array(total);
		let pos = 0;
		for (const p of parts) { result.set(p, pos); pos += p.length; }
		return result.buffer;
	}

	private buildPaperNote(p: {id: string; title: string; authors: string[]; year?: number; pdfPath: string; rslResourceId: number}): string {
		const authorsYaml = p.authors.length > 0
			? p.authors.map(a => `  - "${a}"`).join('\n')
			: '  []';
		return [
			'---',
			'type: paper',
			`title: "${p.title}"`,
			`authors:\n${authorsYaml}`,
			`year:${p.year !== undefined ? ` ${p.year}` : ''}`,
			`pdf_path: "${p.pdfPath}"`,
			`rsl_resource_id: ${p.rslResourceId}`,
			'---',
			'',
			`# ${p.title}`,
			'',
			`**PDF**: [[${p.pdfPath}]]`,
		].join('\n');
	}
}
