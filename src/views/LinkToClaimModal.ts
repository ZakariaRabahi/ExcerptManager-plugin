import {Modal, Notice, Setting} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {Excerpt, Relation} from '../core/types';
import {ensureRelationType} from '../core/relationUtils';

export class LinkToClaimModal extends Modal {
	private plugin: ExcerptManagerPlugin;
	private excerpt: Excerpt;
	private onLinked: () => void;

	private selectedClaimId = '';
	private relationType = '';
	private note = '';

	constructor(plugin: ExcerptManagerPlugin, excerpt: Excerpt, onLinked: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.excerpt = excerpt;
		this.onLinked = onLinked;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('excerpt-manager-modal');
		contentEl.createEl('h2', {text: 'Link excerpt to claim'});

		// Excerpt label (read-only context)
		contentEl.createEl('p', {
			text: `Excerpt: "${this.excerpt.label}"`,
			cls: 'excerpt-manager-source-info',
		});

		const claims = this.plugin.claimStore.listClaims();
		if (claims.length === 0) {
			contentEl.createEl('p', {
				text: 'No claims yet. Create a claim in the workspace first.',
				cls: 'excerpt-manager-source-info',
			});
			new Setting(contentEl).addButton(btn =>
				btn.setButtonText('Close').onClick(() => this.close())
			);
			return;
		}

		this.selectedClaimId = claims[0]?.id ?? '';
		this.relationType = this.plugin.settings.relationTypes[0]?.name ?? '';

		// Claim selector
		new Setting(contentEl)
			.setName('Claim')
			.setDesc('Which claim does this excerpt relate to?')
			.addDropdown(drop => {
				claims.forEach(c => drop.addOption(c.id, c.label));
				drop.setValue(this.selectedClaimId);
				drop.onChange(v => { this.selectedClaimId = v; });
			});

		// Relation type — dropdown of predefined types + optional custom field
		new Setting(contentEl)
			.setName('Relation type')
			.addDropdown(drop => {
				this.plugin.settings.relationTypes.forEach(rt => drop.addOption(rt.name, rt.name));
				drop.addOption('__custom__', 'Custom…');
				drop.setValue(this.relationType);
				drop.onChange(v => {
					this.relationType = v === '__custom__' ? '' : v;
					customRow.style.display = v === '__custom__' ? '' : 'none';
					if (v !== '__custom__') customInput.value = '';
				});
			});

		const customRow = contentEl.createDiv({attr: {style: 'display:none;margin-bottom:8px'}});
		const customInput = customRow.createEl('input', {
			cls: 'excerpt-graph-rel-custom-input',
			type: 'text',
			placeholder: 'Type a custom relation type…',
			attr: {style: 'width:100%'},
		}) as HTMLInputElement;
		customInput.addEventListener('input', () => { this.relationType = customInput.value.trim(); });

		// Optional note
		new Setting(contentEl)
			.setName('Note')
			.setDesc('Optional comment about this relationship')
			.addText(text => text
				.setPlaceholder('Why does this excerpt support/contradict…')
				.onChange(v => { this.note = v; })
			);

		// Buttons
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Link')
				.setCta()
				.onClick(() => void this.save())
			)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close())
			);
	}

	private async save(): Promise<void> {
		if (!this.selectedClaimId) {
			new Notice('Please select a claim.');
			return;
		}
		const relType = this.relationType;
		if (!relType) {
			new Notice('Please select or enter a relation type.');
			return;
		}

		const claimPath = `${this.plugin.settings.claimFolder}/${this.selectedClaimId}`;

		// Don't add a duplicate relation to the same claim with the same type
		const alreadyLinked = this.excerpt.relations.some(
			r => r.target === claimPath && r.type === relType
		);
		if (alreadyLinked) {
			new Notice('This excerpt is already linked to that claim with the same relation type.');
			return;
		}

		// Register new custom type with an auto-assigned color
		await ensureRelationType(this.plugin, relType);

		const newRelation: Relation = {
			type: relType,
			target: claimPath,
			...(this.note.trim() ? {note: this.note.trim()} : {}),
		};

		try {
			await this.plugin.store.updateRelations(
				this.excerpt.id,
				[...this.excerpt.relations, newRelation]
			);
			new Notice(`Linked to claim as "${relType}"`);
			this.onLinked();
			this.close();
		} catch (e) {
			new Notice(`Failed to link: ${String(e)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
