import {requestUrl} from 'obsidian';

// ─── Normalized shapes returned by the collection helpers ─────────────────────

export interface RslResource {
	id: number;
	title: string;
	author: string;
	year: string;
	raw: Record<string, unknown>;
}

export interface RslSelector {
	id: number;
	referent: number;
	page: number;
	rects: number[][];
	raw: Record<string, unknown>;
}

export interface RslLink {
	id: number;
	source: number;
	target: number;
	property: string;
	raw: Record<string, unknown>;
}

export class RslApiClient {
	constructor(public baseUrl: string) {
		this.baseUrl = RslApiClient.cleanBaseUrl(baseUrl);
	}

	static cleanBaseUrl(url: string): string {
		// Strip fragment (#...) and trailing slash
		return url.replace(/#.*$/, '').replace(/\/$/, '');
	}

	// ─── Test ─────────────────────────────────────────────────────────────────

	async testConnection(): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: `${this.baseUrl}/test/hello`,
				method: 'GET',
				throw: false,
			});
			if (res.status >= 200 && res.status < 300) return true;
			throw new Error(`HTTP ${res.status} — ${String(res.text ?? '').slice(0, 120)}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(msg);
		}
	}

	// ─── Collection fetches (flat, no filters) ────────────────────────────────

	async fetchResources(): Promise<RslResource[]> {
		const raw = await this.fetchCollection('/resource');
		return raw.map(r => {
			const meta = (r['resource/metadata'] ?? {}) as Record<string, unknown>;
			const id = RslApiClient.extractId(r);
			return {
				id,
				title:  RslApiClient.extractStr(meta, ['title', 'name', 'label'])
					?? RslApiClient.extractStr(r, ['title', 'resource/title', 'name', 'label'])
					?? `Resource ${id}`,
				author: RslApiClient.extractStr(meta, ['author'])
					?? RslApiClient.extractStr(r, ['author', 'resource/author'])
					?? '',
				year:   RslApiClient.extractStr(meta, ['year'])
					?? RslApiClient.extractStr(r, ['year', 'resource/year'])
					?? '',
				raw:    r,
			};
		}).filter(r => r.id > 0);
	}

	async fetchSelectors(): Promise<RslSelector[]> {
		try {
			const raw = await this.fetchCollection('/selector');
			return raw.map(s => {
				const pointer = (s['pointer'] ?? s['selector/pointer']) as Record<string, unknown> | undefined;
				const rects   = Array.isArray(pointer?.['rects']) ? pointer!['rects'] as number[][] : [];
				return {
					id:       RslApiClient.extractId(s),
					referent: RslApiClient.extractNestedId(s, ['referent', 'selector/referent', 'resource']),
					page:     Number(pointer?.['page'] ?? s['page'] ?? 1),
					rects,
					raw:      s,
				};
			}).filter(s => s.id > 0);
		} catch {
			return [];
		}
	}

	async fetchLinks(): Promise<RslLink[]> {
		try {
			const raw = await this.fetchCollection('/link');
			return raw.map(l => ({
				id:       RslApiClient.extractId(l),
				source:   RslApiClient.extractNestedId(l, ['link/source', 'source']),
				target:   RslApiClient.extractNestedId(l, ['link/target', 'target']),
				property: RslApiClient.extractStr(l, ['property', 'link/property', 'type']) ?? '',
				raw:      l,
			})).filter(lk => lk.id > 0);
		} catch {
			return []; // optional — degrade gracefully
		}
	}

	// ─── Shared collection fetch helper ───────────────────────────────────────

	private async fetchCollection(path: string): Promise<Record<string, unknown>[]> {
		const url = `${this.baseUrl}${path}`;
		console.log(`[RSL] GET ${url}`);
		const res = await requestUrl({url, method: 'GET', throw: false});
		console.log(`[RSL] ${url} → status ${res.status}`);
		console.log(`[RSL] ${url} → body:`, String(res.text ?? '').slice(0, 500));
		if (res.status === 404) return []; // endpoint exists but no data yet
		if (res.status >= 400) {
			throw new Error(`HTTP ${res.status} from ${path}`);
		}
		const text = String(res.text ?? '').trim();
		if (!text || text === 'null') return [];
		if (text.startsWith('<')) {
			throw new Error(`Server returned HTML instead of JSON. Check the RSL base URL in settings.`);
		}
		const parsed = res.json as unknown;
		console.log(`[RSL] ${url} → parsed:`, parsed);
		if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
		if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
		return [];
	}

	// ─── Field extraction helpers ─────────────────────────────────────────────

	/** Extract a numeric ID from any of the known RSL field names. */
	static extractId(obj: Record<string, unknown>): number {
		for (const key of ['db/id', ':db/id', 'id', '_id']) {
			const v = obj[key];
			if (v !== undefined && v !== null) {
				const n = Number(v);
				if (!isNaN(n) && n > 0) return n;
			}
		}
		return 0;
	}

	/** Extract a nested ID — the field may be a plain number OR a nested {db/id: ...} object. */
	static extractNestedId(obj: Record<string, unknown>, keys: string[]): number {
		for (const key of keys) {
			const v = obj[key];
			if (v === undefined || v === null) continue;
			if (typeof v === 'number') return v;
			if (typeof v === 'string') { const n = Number(v); if (!isNaN(n) && n > 0) return n; }
			if (typeof v === 'object') return RslApiClient.extractId(v as Record<string, unknown>);
		}
		return 0;
	}

	/** Extract a string value from any of the given field names. */
	static extractStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
		for (const key of keys) {
			const v = obj[key];
			if (typeof v === 'string' && v) return v;
			if (typeof v === 'number') return String(v);
		}
		return undefined;
	}

	// ─── Legacy param-based getters (used by RslSyncService push/pull) ────────

	async getResource(params: {id?: number; name?: string; title?: string; year?: string}): Promise<unknown> {
		const qs = new URLSearchParams();
		if (params.id    !== undefined) qs.set('id',    String(params.id));
		if (params.name  !== undefined) qs.set('name',  params.name);
		if (params.title !== undefined) qs.set('title', params.title);
		if (params.year  !== undefined) qs.set('year',  params.year);
		const qsStr = qs.toString();
		return this.fetchCollection(`/resource${qsStr ? '?' + qsStr : ''}`);
	}

	async getSelector(params: {id?: number; referent?: number}): Promise<unknown> {
		const qs = new URLSearchParams();
		if (params.id       !== undefined) qs.set('id',       String(params.id));
		if (params.referent !== undefined) qs.set('referent', String(params.referent));
		const qsStr = qs.toString();
		return this.fetchCollection(`/selector${qsStr ? '?' + qsStr : ''}`);
	}

	async getLink(params: {id?: number; source?: number; target?: number}): Promise<unknown> {
		const qs = new URLSearchParams();
		if (params.id     !== undefined) qs.set('id',     String(params.id));
		if (params.source !== undefined) qs.set('source', String(params.source));
		if (params.target !== undefined) qs.set('target', String(params.target));
		const qsStr = qs.toString();
		return this.fetchCollection(`/link${qsStr ? '?' + qsStr : ''}`);
	}

	// ─── Mutations ────────────────────────────────────────────────────────────

	async createResource(
		fileBuffer: ArrayBuffer,
		filename: string,
		author: string,
		title: string,
		year: string,
	): Promise<{id: number}> {
		const body = this.buildMultipart({author, title, year}, {name: 'file', filename, buffer: fileBuffer});
		const res  = await requestUrl({
			url: `${this.baseUrl}/resource/article`,
			method: 'POST',
			headers: {'Content-Type': `multipart/form-data; boundary=${body.boundary}`},
			body: body.buffer,
			throw: false,
		});
		console.log(`[RSL] POST /resource/article → ${res.status}: ${String(res.text ?? '').slice(0, 300)}`);
		if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(res.text ?? '').slice(0, 200)}`);
		const text = String(res.text ?? '').trim();
		if (text.startsWith('<')) throw new Error(`Server returned HTML — check the RSL base URL in settings`);
		const json = res.json as Record<string, unknown>;
		const id = RslApiClient.extractId(json);
		if (!id) throw new Error(`Server returned no ID in response: ${text.slice(0, 100)}`);
		return {id};
	}

	async updateResource(
		id: number,
		fileBuffer?: ArrayBuffer,
		author?: string,
		title?: string,
		year?: string,
	): Promise<unknown> {
		const fields: Record<string, string> = {id: String(id)};
		if (author !== undefined) fields['author'] = author;
		if (title  !== undefined) fields['title']  = title;
		if (year   !== undefined) fields['year']   = year;
		const file = fileBuffer ? {name: 'file', filename: `resource-${id}.pdf`, buffer: fileBuffer} : undefined;
		const body = this.buildMultipart(fields, file);
		const res  = await requestUrl({
			url: `${this.baseUrl}/resource/article`,
			method: 'PUT',
			headers: {'Content-Type': `multipart/form-data; boundary=${body.boundary}`},
			body: body.buffer,
		});
		return res.json as unknown;
	}

	async deleteResource(id: number): Promise<void> {
		await requestUrl({url: `${this.baseUrl}/resource?id=${id}`, method: 'DELETE'});
	}

	async createSelector(referent: number, page: number, rects: number[][]): Promise<{id: number}> {
		const payload = {referent, pointer: {page, rects}};
		console.log(`[RSL] POST /selector/pdf`, JSON.stringify(payload));
		const res = await requestUrl({
			url: `${this.baseUrl}/selector/pdf`,
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(payload),
			throw: false,
		});
		console.log(`[RSL] POST /selector/pdf → ${res.status}: ${String(res.text ?? '').slice(0, 300)}`);
		if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(res.text ?? '').slice(0, 200)}`);
		const selJson = res.json as Record<string, unknown>;
		const selId = RslApiClient.extractId(selJson);
		if (!selId) throw new Error(`Server returned no ID: ${String(res.text ?? '').slice(0, 100)}`);
		return {id: selId};
	}

	async updateSelector(id: number, page: number, rects: number[][]): Promise<unknown> {
		const res = await requestUrl({
			url: `${this.baseUrl}/selector/pdf`,
			method: 'PUT',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({id, pointer: {page, rects}}),
			throw: false,
		});
		if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(res.text ?? '').slice(0, 200)}`);
		return res.json as unknown;
	}

	async deleteSelector(id: number): Promise<void> {
		await requestUrl({url: `${this.baseUrl}/selector?id=${id}`, method: 'DELETE'});
	}

	async createLink(source: number, target: number, property: string): Promise<{id: number}> {
		const qs = new URLSearchParams({source: String(source), target: String(target), property});
		console.log(`[RSL] POST /link?${qs.toString()}`);
		const res = await requestUrl({
			url: `${this.baseUrl}/link?${qs.toString()}`,
			method: 'POST',
			throw: false,
		});
		console.log(`[RSL] POST /link → ${res.status}: ${String(res.text ?? '').slice(0, 300)}`);
		if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${String(res.text ?? '').slice(0, 200)}`);
		const linkJson = res.json as Record<string, unknown>;
		const linkId = RslApiClient.extractId(linkJson);
		if (!linkId) throw new Error(`Server returned no ID: ${String(res.text ?? '').slice(0, 100)}`);
		return {id: linkId};
	}

	async deleteLink(id: number): Promise<void> {
		await requestUrl({url: `${this.baseUrl}/link?id=${id}`, method: 'DELETE'});
	}

	async getEntityFile(id: number): Promise<ArrayBuffer> {
		const res = await requestUrl({url: `${this.baseUrl}/entity/${id}`, method: 'GET'});
		return res.arrayBuffer;
	}

	// ─── Multipart form helper ────────────────────────────────────────────────

	private buildMultipart(
		fields: Record<string, string>,
		file?: {name: string; filename: string; buffer: ArrayBuffer},
	): {boundary: string; buffer: ArrayBuffer} {
		const boundary = '----ExcerptManager' + Date.now();
		const enc      = new TextEncoder();
		const parts: Uint8Array[] = [];

		for (const [name, value] of Object.entries(fields)) {
			parts.push(enc.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			));
		}

		if (file) {
			parts.push(enc.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
			));
			parts.push(new Uint8Array(file.buffer));
			parts.push(enc.encode('\r\n'));
		}

		parts.push(enc.encode(`--${boundary}--\r\n`));

		const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
		const combined    = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of parts) {
			combined.set(part, offset);
			offset += part.length;
		}

		return {boundary, buffer: combined.buffer};
	}
}
