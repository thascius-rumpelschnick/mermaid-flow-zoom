import { EDGE_SCROLL_ZONE, HELP_ITEMS, MAX_SCALE, MIN_SCALE, ZOOM_STEP } from './constants';

type DiagramKind = 'sequence' | 'flowchart' | 'class' | 'state' | 'timeline' | 'generic';

interface Profile {
	minHeight: number;
	maxHeightRatio: number;
	maxHeight: number;
	fitMode: 'width' | 'contain';
	padding: number;
}

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Point {
	x: number;
	y: number;
}

interface PinchState {
	centerX: number;
	centerY: number;
	distance: number;
}

interface DragStart {
	pointerId: number;
	pointerX: number;
	pointerY: number;
	x: number;
	y: number;
}

interface FullscreenRestore {
	parent: HTMLElement | null;
	nextSibling: ChildNode | null;
	width: string;
	height: string;
	autoHeight: string | undefined;
	lastAutoWidth: number;
}

export class MermaidZoomInstance {
	container!: HTMLDivElement;
	private viewport!: HTMLDivElement;
	private content!: HTMLDivElement;
	private toolbar!: HTMLDivElement;
	private help!: HTMLDivElement;
	private helpButton!: HTMLButtonElement;
	private fullscreenButton!: HTMLButtonElement;

	private scale = 1;
	private x = 0;
	private y = 0;
	private activePointers = new Map<number, Point>();
	private lastPinch: PinchState | null = null;
	private dragStart: DragStart | null = null;
	private fullscreenRestore: FullscreenRestore | null = null;
	private frame: number | null = null;
	private initialFit: { scale: number; x: number; y: number } | null = null;
	private lastAutoWidth = 0;
	private abortController = new AbortController();
	private resizeObserver: ResizeObserver | null = null;

	private readonly originalParent: HTMLElement | null;
	private readonly originalNextSibling: ChildNode | null;
	private readonly originalInlineStyle: string | null;
	private readonly originalWidth: string | null;
	private readonly originalHeight: string | null;
	private readonly diagramKind: DiagramKind;

	constructor(private readonly svg: SVGSVGElement, private readonly onDestroy: () => void) {
		this.originalParent = svg.parentElement;
		this.originalNextSibling = svg.nextSibling;
		this.originalInlineStyle = svg.getAttribute('style');
		this.originalWidth = svg.getAttribute('width');
		this.originalHeight = svg.getAttribute('height');
		this.diagramKind = this.detectDiagramKind();

		this.build();
		this.bind();
		this.autoSizeSoon();
		this.resetSoon();
	}

	private build() {
		this.svg.dataset.mfzEnhanced = 'true';
		this.svg.removeAttribute('width');
		this.svg.removeAttribute('height');

		this.container = createDiv({ cls: ['mfz-container', `mfz-kind-${this.diagramKind}`] });
		this.container.tabIndex = 0;
		this.container.dataset.mfzKind = this.diagramKind;

		this.viewport = createDiv({ cls: 'mfz-viewport' });
		this.content = createDiv({ cls: 'mfz-content' });
		this.toolbar = createDiv({ cls: 'mfz-toolbar' });

		this.helpButton = this.button('?', 'How to use', () => this.toggleHelp());
		this.helpButton.setAttribute('aria-expanded', 'false');
		const zoomOutButton = this.button('−', 'Zoom out', () => this.zoomAtCenter(1 / ZOOM_STEP));
		const zoomInButton = this.button('+', 'Zoom in', () => this.zoomAtCenter(ZOOM_STEP));
		const resetButton = this.button('⟲', 'Reset and fit', () => this.reset());
		this.fullscreenButton = this.button('⛶', 'View fullscreen', () => this.toggleFullscreen());

		this.toolbar.append(this.helpButton, zoomOutButton, zoomInButton, resetButton, this.fullscreenButton);

		this.help = this.buildHelp();

		this.originalParent?.insertBefore(this.container, this.originalNextSibling);
		this.content.appendChild(this.svg);
		this.viewport.appendChild(this.content);
		this.container.append(this.viewport, this.toolbar, this.help);
	}

	private buildHelp() {
		const help = createDiv({ cls: 'mfz-help' });
		help.hidden = true;

		const list = help.createEl('dl');
		for (const [input, action] of HELP_ITEMS) {
			list.createEl('dt', { text: input });
			list.createEl('dd', { text: action });
		}

		if (this.diagramKind === 'sequence') {
			help.createEl('p', { text: 'Sequence diagrams fit to width; drag vertically to see more.' });
		}
		return help;
	}

	private toggleHelp(force?: boolean) {
		const show = force ?? this.help.hidden;
		this.help.hidden = !show;
		this.helpButton.toggleClass('is-active', show);
		this.helpButton.setAttribute('aria-expanded', String(show));
	}

	private detectDiagramKind(): DiagramKind {
		const classText = Array.from(this.svg.classList).join(' ').toLowerCase();
		const ariaText = (this.svg.getAttribute('aria-roledescription') ?? '').toLowerCase();
		const labelText = (this.svg.getAttribute('aria-label') ?? '').toLowerCase();
		const text = `${classText} ${ariaText} ${labelText}`;

		if (text.includes('sequence') || text.includes('sequencediagram')) return 'sequence';
		if (text.includes('flowchart') || text.includes('graph')) return 'flowchart';
		if (text.includes('classdiagram')) return 'class';
		if (text.includes('statediagram')) return 'state';
		if (text.includes('gantt')) return 'timeline';
		return 'generic';
	}

	private getProfile(): Profile {
		const narrow = this.container.clientWidth < 640;
		if (this.diagramKind === 'sequence') {
			return {
				minHeight: 120,
				maxHeightRatio: 0.78,
				maxHeight: 900,
				fitMode: 'width',
				padding: narrow ? 18 : 36,
			};
		}

		return {
			minHeight: 120,
			maxHeightRatio: 0.72,
			maxHeight: 760,
			fitMode: 'contain',
			padding: narrow ? 18 : 32,
		};
	}

	private button(label: string, title: string, onClick: () => void) {
		const button = createEl('button', { text: label, attr: { type: 'button', title, 'aria-label': title } });
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.focus();
			onClick();
		});
		return button;
	}

	private bind() {
		const options = { signal: this.abortController.signal };
		const passiveFalse = { signal: this.abortController.signal, passive: false };

		this.viewport.addEventListener('wheel', (event) => this.onWheel(event), passiveFalse);
		this.viewport.addEventListener('pointerdown', (event) => this.onPointerDown(event), options);
		this.viewport.addEventListener('pointermove', (event) => this.onPointerMove(event), options);
		this.viewport.addEventListener('pointerup', (event) => this.onPointerUp(event), options);
		this.viewport.addEventListener('pointercancel', (event) => this.onPointerUp(event), options);
		this.viewport.addEventListener('dblclick', (event) => {
			if (!this.isFocused()) return;
			event.preventDefault();
			this.zoomAt(event.clientX, event.clientY, ZOOM_STEP * ZOOM_STEP);
		}, options);
		this.container.addEventListener('click', () => this.focus(), options);
		this.container.addEventListener('keydown', (event) => this.onKeyDown(event), options);

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.isFullscreen()) this.autoSizeSoon();
			if (this.isNearInitialFit()) this.resetSoon();
		});
		this.resizeObserver.observe(this.container);
	}

	private focus() {
		this.container.doc.querySelectorAll('.mfz-container.is-focused').forEach((el) => {
			if (el !== this.container) el.removeClass('is-focused');
		});
		this.container.addClass('is-focused');
	}

	blur() {
		this.container.removeClass('is-focused');
		this.toggleHelp(false);
		this.activePointers.clear();
		this.dragStart = null;
		this.lastPinch = null;
	}

	isFocused() {
		return this.container.hasClass('is-focused');
	}

	private isFullscreen() {
		return this.container.hasClass('is-fullscreen');
	}

	private onKeyDown(event: KeyboardEvent) {
		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			this.zoomAtCenter(ZOOM_STEP);
		} else if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			this.zoomAtCenter(1 / ZOOM_STEP);
		} else if (event.key === '0') {
			event.preventDefault();
			this.reset();
		} else if (event.key === 'Escape' && !this.help.hidden) {
			event.preventDefault();
			this.toggleHelp(false);
		} else if (event.key === 'Escape' && this.isFullscreen()) {
			event.preventDefault();
			this.toggleFullscreen(false);
		} else if (event.key === 'Escape' && this.isFocused()) {
			event.preventDefault();
			this.blur();
		}
	}

	private onWheel(event: WheelEvent) {
		// Unfocused: let the wheel scroll the note as usual.
		if (!this.isFocused()) return;
		event.preventDefault();
		// Obsidian's MarkdownView changes the font size on Ctrl+wheel (= trackpad pinch) and
		// ignores defaultPrevented, so the event must not bubble up to it.
		event.stopPropagation();

		const rect = this.viewport.getBoundingClientRect();
		const nearLeft = event.clientX - rect.left < EDGE_SCROLL_ZONE;
		const nearRight = rect.right - event.clientX < EDGE_SCROLL_ZONE;
		const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || nearLeft || nearRight;

		if (horizontalIntent && !event.ctrlKey && !event.metaKey) {
			const direction = event.deltaX || event.deltaY;
			this.x -= direction;
			this.apply();
			return;
		}

		const delta = event.deltaY || event.deltaX;
		const factor = Math.exp(-delta * 0.0015);
		this.zoomAt(event.clientX, event.clientY, factor);
	}

	private onPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		this.toggleHelp(false);
		// The first press only focuses the diagram; dragging starts with the next one.
		if (!this.isFocused()) {
			this.focus();
			return;
		}
		this.viewport.setPointerCapture(event.pointerId);
		this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (this.activePointers.size === 1) {
			this.dragStart = {
				pointerId: event.pointerId,
				pointerX: event.clientX,
				pointerY: event.clientY,
				x: this.x,
				y: this.y,
			};
		} else if (this.activePointers.size === 2) {
			this.dragStart = null;
			this.lastPinch = this.getPinchState();
		}
	}

	private onPointerMove(event: PointerEvent) {
		if (!this.activePointers.has(event.pointerId)) return;
		this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (this.activePointers.size === 2) {
			const pinch = this.getPinchState();
			if (!pinch || !this.lastPinch) return;
			const factor = pinch.distance / Math.max(1, this.lastPinch.distance);
			this.zoomAt(pinch.centerX, pinch.centerY, factor);
			this.x += pinch.centerX - this.lastPinch.centerX;
			this.y += pinch.centerY - this.lastPinch.centerY;
			this.lastPinch = pinch;
			this.apply();
			return;
		}

		if (!this.dragStart || this.dragStart.pointerId !== event.pointerId) return;
		this.x = this.dragStart.x + event.clientX - this.dragStart.pointerX;
		this.y = this.dragStart.y + event.clientY - this.dragStart.pointerY;
		this.apply();
	}

	private onPointerUp(event: PointerEvent) {
		this.activePointers.delete(event.pointerId);
		this.lastPinch = this.activePointers.size === 2 ? this.getPinchState() : null;
		this.dragStart = null;
	}

	private getPinchState(): PinchState | null {
		const [a, b] = Array.from(this.activePointers.values());
		if (!a || !b) return null;
		return {
			centerX: (a.x + b.x) / 2,
			centerY: (a.y + b.y) / 2,
			distance: Math.hypot(a.x - b.x, a.y - b.y),
		};
	}

	private zoomAtCenter(factor: number) {
		const rect = this.viewport.getBoundingClientRect();
		this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
	}

	private zoomAt(clientX: number, clientY: number, factor: number) {
		const rect = this.viewport.getBoundingClientRect();
		const oldScale = this.scale;
		const nextScale = clamp(oldScale * factor, MIN_SCALE, MAX_SCALE);
		if (nextScale === oldScale) return;

		const localX = clientX - rect.left;
		const localY = clientY - rect.top;
		const contentX = (localX - this.x) / oldScale;
		const contentY = (localY - this.y) / oldScale;

		this.scale = nextScale;
		this.x = localX - contentX * nextScale;
		this.y = localY - contentY * nextScale;
		this.apply();
	}

	private autoSizeSoon() {
		window.requestAnimationFrame(() => this.autoSizeContainer());
	}

	private autoSizeContainer() {
		if (this.isFullscreen()) return;
		if (this.container.style.height && !this.container.dataset.mfzAutoHeight) return;

		const bounds = this.getSvgBounds();
		const width = this.container.clientWidth || this.originalParent?.clientWidth || 800;
		if (!bounds.width || !bounds.height || !width) return;
		if (this.container.dataset.mfzAutoHeight && Math.abs(width - this.lastAutoWidth) < 2) return;

		// Hug the diagram at the scale reset() will draw it: fitted to the width, never enlarged.
		const profile = this.getProfile();
		const scale = Math.min(Math.max(1, width - profile.padding * 2) / bounds.width, 1);
		const contentHeight = bounds.height * scale + profile.padding * 2;
		const maxHeight = Math.min(window.innerHeight * profile.maxHeightRatio, profile.maxHeight);
		const nextHeight = Math.round(clamp(contentHeight, profile.minHeight, maxHeight));

		this.container.setCssStyles({ height: `${nextHeight}px` });
		this.container.dataset.mfzAutoHeight = 'true';
		this.lastAutoWidth = width;
	}

	private resetSoon() {
		window.requestAnimationFrame(() => this.reset());
	}

	reset() {
		const viewport = this.viewport.getBoundingClientRect();
		const bounds = this.getSvgBounds();
		if (!viewport.width || !viewport.height || !bounds.width || !bounds.height) return;

		const size = { width: `${bounds.width}px`, height: `${bounds.height}px` };
		this.content.setCssStyles(size);
		this.svg.setCssStyles(size);

		const profile = this.getProfile();
		const padding = profile.padding;
		const availableWidth = Math.max(1, viewport.width - padding * 2);
		const availableHeight = Math.max(1, viewport.height - padding * 2);
		const widthScale = availableWidth / bounds.width;
		const containScale = Math.min(widthScale, availableHeight / bounds.height, 1);
		const sequenceScale = Math.min(widthScale, 1);
		const scale = profile.fitMode === 'width' ? sequenceScale : containScale;

		this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
		const scaledHeight = bounds.height * this.scale;
		this.x = (viewport.width - bounds.width * this.scale) / 2 - bounds.x * this.scale;
		// Width-fitted diagrams taller than the viewport start at the top; everything else is centered.
		this.y = scaledHeight > availableHeight
			? padding - bounds.y * this.scale
			: (viewport.height - scaledHeight) / 2 - bounds.y * this.scale;
		this.initialFit = { scale: this.scale, x: this.x, y: this.y };
		this.apply();
	}

	private getSvgBounds(): Bounds {
		const viewBox = this.svg.viewBox.baseVal;
		if (viewBox && viewBox.width && viewBox.height) {
			// The SVG box is sized to the viewBox, so its origin already sits at the box's top-left;
			// only the getBBox() fallback below needs an offset.
			return { x: 0, y: 0, width: viewBox.width, height: viewBox.height };
		}

		try {
			const box = this.svg.getBBox();
			if (box.width && box.height) {
				return { x: box.x, y: box.y, width: box.width, height: box.height };
			}
		} catch {
			// Some browsers throw if the SVG is detached or not fully painted yet.
		}

		const rect = this.svg.getBoundingClientRect();
		return { x: 0, y: 0, width: rect.width || 800, height: rect.height || 500 };
	}

	private isNearInitialFit() {
		if (!this.initialFit) return true;
		return (
			Math.abs(this.scale - this.initialFit.scale) < 0.001 &&
			Math.abs(this.x - this.initialFit.x) < 1 &&
			Math.abs(this.y - this.initialFit.y) < 1
		);
	}

	private apply() {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.content.setCssStyles({ transform: `translate(${this.x}px, ${this.y}px) scale(${this.scale})` });
		});
	}

	private toggleFullscreen(force?: boolean) {
		const body = this.container.doc.body;
		const shouldEnter = force ?? !this.isFullscreen();
		if (shouldEnter) {
			this.fullscreenRestore = {
				parent: this.container.parentElement,
				nextSibling: this.container.nextSibling,
				width: this.container.style.width,
				height: this.container.style.height,
				autoHeight: this.container.dataset.mfzAutoHeight,
				lastAutoWidth: this.lastAutoWidth,
			};

			// Inline sizes would override the fullscreen class's 100vw/100vh.
			this.container.setCssStyles({ width: '', height: '' });
			body.appendChild(this.container);
			this.container.addClass('is-fullscreen');
			this.fullscreenButton.setText('⤢');
			body.addClass('mfz-fullscreen-open');
			this.resetSoon();
		} else {
			this.container.removeClass('is-fullscreen');
			this.fullscreenButton.setText('⛶');
			body.removeClass('mfz-fullscreen-open');
			if (this.fullscreenRestore) {
				const { parent, nextSibling } = this.fullscreenRestore;
				if (!parent?.isConnected) {
					// The note this diagram came from is gone; don't leave the container stranded on <body>.
					this.fullscreenRestore = null;
					this.destroy();
					return;
				}
				parent.insertBefore(this.container, nextSibling?.parentElement === parent ? nextSibling : null);
				this.container.setCssStyles({ width: this.fullscreenRestore.width, height: this.fullscreenRestore.height });
				if (this.fullscreenRestore.autoHeight) this.container.dataset.mfzAutoHeight = this.fullscreenRestore.autoHeight;
				else delete this.container.dataset.mfzAutoHeight;
				this.lastAutoWidth = this.fullscreenRestore.lastAutoWidth;
				this.fullscreenRestore = null;
			}
			this.autoSizeSoon();
			this.resetSoon();
		}
	}

	destroy() {
		this.abortController.abort();
		this.resizeObserver?.disconnect();
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.svg.dataset.mfzEnhanced = 'false';

		if (this.originalWidth) this.svg.setAttribute('width', this.originalWidth);
		if (this.originalHeight) this.svg.setAttribute('height', this.originalHeight);
		if (this.originalInlineStyle === null) this.svg.removeAttribute('style');
		else this.svg.setAttribute('style', this.originalInlineStyle);

		if (this.originalParent && this.container.parentElement) {
			const nextSibling = this.originalNextSibling?.parentNode === this.originalParent ? this.originalNextSibling : null;
			this.originalParent.insertBefore(this.svg, nextSibling);
			this.container.remove();
		}
		this.onDestroy();
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}
