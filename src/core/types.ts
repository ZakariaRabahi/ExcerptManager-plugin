export interface Relation {
	type: string;
	target: string;
	note?: string;
	rslLinkId?: number;            // RSL link ID (set after sync)
}

export interface Excerpt {
	id: string;
	label: string;
	source: string;
	page: number;
	selectionText: string;
	selectionRange?: string;       // PDF.js span format: "startIdx,startOffset,endIdx,endOffset"
	selectionRects?: number[][];   // Normalised [x,y,w,h] bounding boxes for RSL selector
	imagePath?: string;            // vault path to captured PNG (image excerpts)
	created: string;
	tags: string[];
	relations: Relation[];
	rslSelectorId?: number;        // RSL selector ID (set after sync)
}

export interface Paper {
	id: string;
	title: string;
	authors: string[];
	year?: number;
	pdfPath: string;
	rslResourceId?: number;        // RSL resource ID (set after sync)
}

export interface RelationType {
	name: string;
	color: string;
}

export interface Claim {
	id: string;
	label: string;
	description?: string;
	created: string;
	tags: string[];
	relations: Relation[];
	rslResourceId?: number;   // RSL resource ID for this claim (set after sync)
	rslSelectorId?: number;   // RSL selector ID for this claim (dummy selector, set after sync)
}

export interface ExcerptManagerSettings {
	excerptFolder: string;
	paperFolder: string;
	claimFolder: string;
	relationTypes: RelationType[];
	autoGenerateBody: boolean;
	defaultViewFilter: 'current-pdf' | 'all';
	graphNodePositions: Record<string, {x: number; y: number}>;
	rslBaseUrl: string;
	rslSyncEnabled: boolean;
}

export const DEFAULT_SETTINGS: ExcerptManagerSettings = {
	excerptFolder: 'excerpts',
	paperFolder: 'papers',
	claimFolder: 'claims',
	relationTypes: [
		{ name: 'supports',      color: '#4CAF50' },
		{ name: 'contradicts',   color: '#F44336' },
		{ name: 'refines',       color: '#2196F3' },
		{ name: 'related-to',    color: '#9C27B0' },
	],
	autoGenerateBody: true,
	defaultViewFilter: 'current-pdf',
	graphNodePositions: {},
	rslBaseUrl: 'https://www.ross-tech.org/api',
	rslSyncEnabled: false,
};
