import {GraphDataBuilder} from '../graph/GraphDataBuilder';
import {GraphRenderer} from '../graph/GraphRenderer';
import ExcerptManagerPlugin from '../main';

export class GraphView {
	private builder: GraphDataBuilder;
	private renderer: GraphRenderer | null = null;
	private container: HTMLElement;
	private plugin: ExcerptManagerPlugin;

	constructor(container: HTMLElement, plugin: ExcerptManagerPlugin) {
		this.container = container;
		this.plugin = plugin;
		this.builder = new GraphDataBuilder(plugin);
	}

	render(): void {
		this.container.empty();
		const data = this.builder.build();
		this.renderer = new GraphRenderer(this.container, this.plugin, data);
		this.renderer.render();
	}

	exportAsSvg(): void {
		this.renderer?.exportAsSvg();
	}

	exportAsJson(): void {
		if (!this.renderer) return;
		const data = this.builder.build();
		this.renderer.exportAsJson(data);
	}

	destroy(): void {
		this.renderer?.destroy();
		this.renderer = null;
	}
}
