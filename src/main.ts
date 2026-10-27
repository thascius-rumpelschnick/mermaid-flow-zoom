import { Notice, Plugin } from 'obsidian';
import { MermaidZoomInstance } from './zoom-instance';

const MERMAID_SVG_SELECTOR = ".mermaid svg, .mermaid-rendered svg, svg[id^='mermaid']";

export default class MermaidFlowZoomPlugin extends Plugin {
	private instances = new Set<MermaidZoomInstance>();

	onload() {
		this.registerMarkdownPostProcessor((el) => {
			window.setTimeout(() => this.enhanceMermaid(el), 0);
		});

		this.observeDynamicMermaid();

		// Clicking anywhere outside a focused diagram releases it, so scrolling the note works again.
		this.registerDomEvent(activeDocument, 'pointerdown', (event) => {
			const target = event.target instanceof Node ? event.target : null;
			for (const instance of this.instances) {
				if (instance.isFocused() && !instance.container.contains(target)) instance.blur();
			}
		}, { capture: true });

		this.addCommand({
			id: 'reset-visible-mermaid-diagrams',
			name: 'Reset visible Mermaid diagrams',
			callback: () => {
				let count = 0;
				for (const instance of this.instances) {
					if (instance.container.isConnected) {
						instance.reset();
						count += 1;
					}
				}
				new Notice(`Reset ${count} Mermaid diagram${count === 1 ? '' : 's'}.`);
			},
		});
	}

	onunload() {
		activeDocument.body.removeClass('mfz-fullscreen-open');
		for (const instance of this.instances) instance.destroy();
		this.instances.clear();
	}

	private observeDynamicMermaid() {
		const pendingNodes = new Set<Element>();
		let sawRemoval = false;
		let queued = false;
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (this.nodeMayContainMermaid(node)) pendingNodes.add(node);
				}
				if (mutation.removedNodes.length) sawRemoval = true;
			}

			if (queued || (!pendingNodes.size && !(sawRemoval && this.instances.size))) return;
			queued = true;
			window.requestAnimationFrame(() => {
				queued = false;
				if (sawRemoval) this.pruneDetachedInstances();
				sawRemoval = false;
				for (const node of pendingNodes) {
					if (node.isConnected) this.enhanceMermaid(node);
				}
				pendingNodes.clear();
			});
		});

		observer.observe(activeDocument.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
	}

	// Destroying a detached instance puts the plain SVG back into its (detached) parent,
	// so if Obsidian re-attaches that subtree later the observer enhances it again.
	private pruneDetachedInstances() {
		for (const instance of this.instances) {
			if (!instance.container.isConnected) instance.destroy();
		}
	}

	private nodeMayContainMermaid(node: Node): node is Element {
		if (!node.instanceOf(HTMLElement) && !node.instanceOf(SVGElement)) return false;
		if (node.closest('.mfz-container')) return false;
		if (node.closest('.mermaid, .mermaid-rendered')) return true;
		if (node.instanceOf(SVGElement)) return (node.getAttribute('id') ?? '').toLowerCase().includes('mermaid');
		return Boolean(node.querySelector(".mermaid, .mermaid-rendered, svg[id^='mermaid']"));
	}

	private enhanceMermaid(root: Element) {
		const candidates = Array.from(root.querySelectorAll<SVGSVGElement>(MERMAID_SVG_SELECTOR));
		if (root.instanceOf(SVGSVGElement) && root.matches(MERMAID_SVG_SELECTOR)) candidates.unshift(root);

		for (const svg of candidates) {
			if (svg.closest('.mfz-container') || svg.dataset.mfzEnhanced === 'true') continue;
			if (!this.looksLikeMermaid(svg)) continue;

			const instance: MermaidZoomInstance = new MermaidZoomInstance(svg, () => this.instances.delete(instance));
			this.instances.add(instance);
		}
	}

	private looksLikeMermaid(svg: SVGSVGElement) {
		if (svg.closest('.mermaid, .mermaid-rendered')) return true;
		return (svg.getAttribute('id') ?? '').toLowerCase().includes('mermaid');
	}
}
