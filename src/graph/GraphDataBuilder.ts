import ExcerptManagerPlugin from '../main';
import {Excerpt} from '../core/types';

export interface ExcerptNode {
	id: string;
	label: string;
	page: number;
	selectionText: string;
	selectionRange?: string;
	imagePath?: string;
	sourcePaperId: string;
	relations: Array<{type: string; targetId: string; targetType: 'claim' | 'excerpt' | 'paper'}>;
}

export interface ClaimNode {
	id: string;
	label: string;
	excerpts: ExcerptNode[];
	relations: Array<{type: string; targetId: string; targetType: 'claim' | 'excerpt' | 'paper'}>;
}

export interface PaperNode {
	id: string;
	title: string;
	authors: string[];
	year?: number;
	pdfPath: string;
	claims: ClaimNode[];
	unlinkedExcerpts: ExcerptNode[];
	isVirtual?: boolean;   // true = PDF exists in vault but no paper note yet
}

export interface GraphData {
	papers: PaperNode[];
	orphanClaims: ClaimNode[];
	lastBuilt: number;
}

export class GraphDataBuilder {
	private cachedData: GraphData | null = null;

	constructor(private plugin: ExcerptManagerPlugin) {}

	build(): GraphData {
		const papers = this.plugin.paperStore.listPapers();
		const allClaims = this.plugin.claimStore.listClaims();
		const allExcerpts = this.plugin.store.listExcerpts();
		const claimFolder = this.plugin.settings.claimFolder;
		const paperFolder = this.plugin.settings.paperFolder;

		// Build claim nodes: for each claim, find all excerpts linked to it
		const claimNodeMap = new Map<string, ClaimNode>();
		for (const claim of allClaims) {
			const linkedExcerpts = allExcerpts.filter(e =>
				e.relations.some(r => r.target.split('/').pop() === claim.id)
			);
			const claimRelations = (claim.relations ?? []).map(r => ({
				type: r.type,
				targetId: r.target.split('/').pop() ?? r.target,
				targetType: r.target.startsWith(claimFolder) ? 'claim' as const
				          : r.target.startsWith(paperFolder) ? 'paper' as const
				          : 'excerpt' as const,
			}));
			claimNodeMap.set(claim.id, {
				id: claim.id,
				label: claim.label,
				excerpts: linkedExcerpts.map(e => this.toExcerptNode(e, claimFolder, paperFolder)),
				relations: claimRelations,
			});
		}

		// Build paper nodes
		const paperNodes: PaperNode[] = papers.map(paper => {
			const paperPath = `${this.plugin.settings.paperFolder}/${paper.id}`;
			const paperExcerpts = allExcerpts.filter(e => e.source === paperPath);

			// Claims that have at least one excerpt from this paper
			const claimsForPaper = new Map<string, ClaimNode>();
			for (const excerpt of paperExcerpts) {
				for (const rel of excerpt.relations) {
					const claimId = rel.target.split('/').pop() ?? '';
					if (claimId && claimNodeMap.has(claimId)) {
						claimsForPaper.set(claimId, claimNodeMap.get(claimId)!);
					}
				}
			}

			const unlinkedExcerpts = paperExcerpts.filter(e =>
				!e.relations.some(r => r.target.startsWith(claimFolder))
			);

			return {
				id: paper.id,
				title: paper.title,
				authors: paper.authors,
				year: paper.year,
				pdfPath: paper.pdfPath,
				claims: Array.from(claimsForPaper.values()),
				unlinkedExcerpts: unlinkedExcerpts.map(e => this.toExcerptNode(e, claimFolder, paperFolder)),
			};
		});

		// Virtual paper nodes: PDFs in the vault that have no paper note yet
		const registeredPdfPaths = new Set(paperNodes.map(p => p.pdfPath));
		const vaultPdfs = this.plugin.app.vault.getFiles().filter(f => f.extension === 'pdf');
		for (const pdfFile of vaultPdfs) {
			if (registeredPdfPaths.has(pdfFile.path)) continue;
			const title = pdfFile.basename.replace(/[-_]+/g, ' ').trim();
			const id    = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
			paperNodes.push({
				id,
				title,
				authors: [],
				pdfPath: pdfFile.path,
				claims: [],
				unlinkedExcerpts: [],
				isVirtual: true,
			});
		}

		// Orphan claims: claims with no excerpts at all
		const orphanClaims = allClaims
			.filter(c => !(claimNodeMap.get(c.id)?.excerpts.length))
			.map(c => claimNodeMap.get(c.id)!);

		const data: GraphData = {papers: paperNodes, orphanClaims, lastBuilt: Date.now()};
		this.cachedData = data;
		return data;
	}

	needsRebuild(since: number): boolean {
		if (!this.cachedData) return true;
		return this.cachedData.lastBuilt < since;
	}

	filter(data: GraphData, paperId?: string): GraphData {
		if (!paperId) return data;
		return {
			...data,
			papers: data.papers.filter(p => p.id === paperId),
		};
	}

	private toExcerptNode(excerpt: Excerpt, claimFolder: string, paperFolder?: string): ExcerptNode {
		return {
			id: excerpt.id,
			label: excerpt.label,
			page: excerpt.page,
			selectionText: excerpt.selectionText,
			selectionRange: excerpt.selectionRange,
			imagePath: excerpt.imagePath,
			sourcePaperId: excerpt.source?.split('/').pop() ?? '',
			// Excerpt relations to papers are not allowed; only excerpt → claim → paper
		relations: excerpt.relations
			.filter(r => !(paperFolder && r.target.startsWith(paperFolder)))
			.map(r => ({
				type: r.type,
				targetId: r.target.split('/').pop() ?? r.target,
				targetType: r.target.startsWith(claimFolder) ? 'claim' as const : 'excerpt' as const,
			})),
		};
	}
}
