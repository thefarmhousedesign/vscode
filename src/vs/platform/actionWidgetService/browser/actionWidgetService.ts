/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as dom from 'vs/base/browser/dom';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IAnchor } from 'vs/base/browser/ui/contextview/contextview';
import { IAction } from 'vs/base/common/actions';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { CodeActionTrigger, CodeActionTriggerSource, CodeActionKind } from 'vs/editor/contrib/codeAction/common/types';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { localize } from 'vs/nls';
import { IListEvent, IListMouseEvent, IListRenderer } from 'vs/base/browser/ui/list/list';
import { List } from 'vs/base/browser/ui/list/listWidget';
import { CodeActionKeybindingResolver } from 'vs/editor/contrib/codeAction/browser/codeActionKeybindingResolver';
import { KeybindingLabel } from 'vs/base/browser/ui/keybindingLabel/keybindingLabel';
import { Codicon } from 'vs/base/common/codicons';
import { OS } from 'vs/base/common/platform';
import { acceptSelectedCodeActionCommand, previewSelectedCodeActionCommand } from 'vs/editor/contrib/codeAction/browser/codeAction';

export interface ActionItem {
	action: any;
}

export interface ActionSet extends IDisposable {
	readonly validActions: readonly ActionItem[];
	readonly allActions: readonly ActionItem[];
	readonly hasAutoFix: boolean;

	readonly documentation: readonly any[];
}

export interface ActionWidgetDelegate {
	onSelectAction(action: ActionItem, trigger: CodeActionTrigger, options: { readonly preview: boolean }): Promise<any>;
	onHide(cancelled: boolean): void;
}

export interface IActionWidgetService {
	readonly _serviceBrand: undefined;
	showActionWidget(visible: RawContextKey<boolean>, trigger: CodeActionTrigger, codeActions: ActionSet, anchor: IAnchor, container: HTMLElement | undefined, options: CodeActionShowOptions, delegate: ActionWidgetDelegate): void;
	hide(): void;
	focusNext(): void;
	focusPrevious(): void;
	acceptSelected(options?: { readonly preview?: boolean }): void;
	isVisible: boolean;
}

export const IActionWidgetService = createDecorator<IActionWidgetService>('actionWidgetService');
// TODO: Take a look at user storage for this so it is preserved across windows and on reload.
let showDisabled = false;
export class ActionWidgetService extends Disposable implements IActionWidgetService {
	declare readonly _serviceBrand: undefined;
	private static _instance?: ActionWidgetService;

	public static get INSTANCE(): ActionWidgetService | undefined { return this._instance; }

	public static getOrCreateInstance(instantiationService: IInstantiationService): ActionWidgetService {
		if (!this._instance) {
			this._instance = instantiationService.createInstance(ActionWidgetService);
		}
		return this._instance;
	}
	private currentShowingContext?: {
		readonly options: CodeActionShowOptions;
		readonly trigger: CodeActionTrigger;
		readonly anchor: IAnchor;
		readonly container: HTMLElement | undefined;
		readonly codeActions: ActionSet;
		readonly delegate: ActionWidgetDelegate;
	};

	private readonly codeActionList = this._register(new MutableDisposable<CodeActionList>());
	private _contextKey: RawContextKey<boolean> | undefined;
	public get isVisible(): boolean {
		return !!this.currentShowingContext;
	}
	constructor(@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ICommandService private readonly _commandService: ICommandService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IContextViewService private readonly _contextViewService: IContextViewService) {
		super();
	}
	showActionWidget(context: RawContextKey<boolean>, trigger: CodeActionTrigger, codeActions: ActionSet, anchor: IAnchor, container: HTMLElement | undefined, options: CodeActionShowOptions, delegate: ActionWidgetDelegate): void {
		this.currentShowingContext = undefined;
		const visibleContext = context.bindTo(this._contextKeyService);
		this._contextKey = context;
		const actionsToShow = options.includeDisabledActions && (showDisabled || codeActions.validActions.length === 0) ? codeActions.allActions : codeActions.validActions;
		if (!actionsToShow.length) {
			visibleContext.reset();
			return;
		}

		this.currentShowingContext = { trigger, codeActions, anchor, container, delegate, options };

		this._contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				visibleContext.set(true);
				return this.renderWidget(container, trigger, codeActions, options, actionsToShow, delegate);
			},
			onHide: (didCancel: boolean) => {
				visibleContext.reset();
				return this.onWidgetClosed(trigger, options, codeActions, didCancel, delegate);
			},
		}, container, false);
	}

	private renderWidget(element: HTMLElement, trigger: CodeActionTrigger, codeActions: ActionSet, options: CodeActionShowOptions, showingCodeActions: readonly ActionItem[], delegate: ActionWidgetDelegate): IDisposable {
		const renderDisposables = new DisposableStore();

		const widget = document.createElement('div');
		widget.classList.add('codeActionWidget');
		element.appendChild(widget);

		this.codeActionList.value = new CodeActionList(
			showingCodeActions,
			options.showHeaders ?? true,
			(action, options) => {
				this.hide();
				delegate.onSelectAction(action, trigger, options);
			},
			this._keybindingService);

		widget.appendChild(this.codeActionList.value.domNode);

		// Invisible div to block mouse interaction in the rest of the UI
		const menuBlock = document.createElement('div');
		const block = element.appendChild(menuBlock);
		block.classList.add('context-view-block');
		block.style.position = 'fixed';
		block.style.cursor = 'initial';
		block.style.left = '0';
		block.style.top = '0';
		block.style.width = '100%';
		block.style.height = '100%';
		block.style.zIndex = '-1';
		renderDisposables.add(dom.addDisposableListener(block, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));

		// Invisible div to block mouse interaction with the menu
		const pointerBlockDiv = document.createElement('div');
		const pointerBlock = element.appendChild(pointerBlockDiv);
		pointerBlock.classList.add('context-view-pointerBlock');
		pointerBlock.style.position = 'fixed';
		pointerBlock.style.cursor = 'initial';
		pointerBlock.style.left = '0';
		pointerBlock.style.top = '0';
		pointerBlock.style.width = '100%';
		pointerBlock.style.height = '100%';
		pointerBlock.style.zIndex = '2';

		// Removes block on click INSIDE widget or ANY mouse movement
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.POINTER_MOVE, () => pointerBlock.remove()));
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.MOUSE_DOWN, () => pointerBlock.remove()));

		// Action bar
		let actionBarWidth = 0;
		if (!options.fromLightbulb) {
			const actionBar = this.createActionBar(codeActions, options);
			if (actionBar) {
				widget.appendChild(actionBar.getContainer().parentElement!);
				renderDisposables.add(actionBar);
				actionBarWidth = actionBar.getContainer().offsetWidth;
			}
		}

		const width = this.codeActionList.value.layout(actionBarWidth);
		widget.style.width = `${width}px`;

		const focusTracker = renderDisposables.add(dom.trackFocus(element));
		renderDisposables.add(focusTracker.onDidBlur(() => this.hide()));

		return renderDisposables;
	}

	/**
	 * Toggles whether the disabled actions in the code action widget are visible or not.
	 */
	private toggleShowDisabled(newShowDisabled: boolean): void {
		const previousCtx = this.currentShowingContext;

		this.hide();

		showDisabled = newShowDisabled;

		if (previousCtx && this._contextKey) {
			this.showActionWidget(this._contextKey, previousCtx.trigger, previousCtx.codeActions, previousCtx.anchor, previousCtx.container, previousCtx.options, previousCtx.delegate);
		}
	}

	private onWidgetClosed(trigger: CodeActionTrigger, options: CodeActionShowOptions, codeActions: ActionSet, cancelled: boolean, delegate: ActionWidgetDelegate): void {
		type ApplyCodeActionEvent = {
			codeActionFrom: CodeActionTriggerSource;
			validCodeActions: number;
			cancelled: boolean;
		};

		type ApplyCodeEventClassification = {
			codeActionFrom: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The kind of action used to opened the code action.' };
			validCodeActions: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The total number of valid actions that are highlighted and can be used.' };
			cancelled: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The indicator if the menu was selected or cancelled.' };
			owner: 'mjbvz';
			comment: 'Event used to gain insights into how code actions are being triggered';
		};

		this._telemetryService.publicLog2<ApplyCodeActionEvent, ApplyCodeEventClassification>('codeAction.applyCodeAction', {
			codeActionFrom: options.fromLightbulb ? CodeActionTriggerSource.Lightbulb : trigger.triggerAction,
			validCodeActions: codeActions.validActions.length,
			cancelled: cancelled,
		});

		this.currentShowingContext = undefined;

		delegate.onHide(cancelled);
	}

	private createActionBar(codeActions: ActionSet, options: CodeActionShowOptions): ActionBar | undefined {
		const actions = this.getActionBarActions(codeActions, options);
		if (!actions.length) {
			return undefined;
		}

		const container = dom.$('.codeActionWidget-action-bar');
		const actionBar = new ActionBar(container);
		actionBar.push(actions, { icon: false, label: true });
		return actionBar;
	}

	public hide() {
		this.codeActionList.clear();
		this._contextViewService.hideContextView();
	}

	public focusPrevious() {
		this.codeActionList.value?.focusPrevious();
	}

	public focusNext() {
		this.codeActionList.value?.focusNext();
	}

	public acceptSelected(options?: { readonly preview?: boolean }) {
		this.codeActionList.value?.acceptSelected(options);
	}

	private getActionBarActions(codeActions: ActionSet, options: CodeActionShowOptions): IAction[] {
		const actions = codeActions.documentation.map((command): IAction => ({
			id: command.id,
			label: command.title,
			tooltip: command.tooltip ?? '',
			class: undefined,
			enabled: true,
			run: () => this._commandService.executeCommand(command.id, ...(command.arguments ?? [])),
		}));

		if (options.includeDisabledActions && codeActions.validActions.length > 0 && codeActions.allActions.length !== codeActions.validActions.length) {
			actions.push(showDisabled ? {
				id: 'hideMoreCodeActions',
				label: localize('hideMoreCodeActions', 'Hide Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => this.toggleShowDisabled(false)
			} : {
				id: 'showMoreCodeActions',
				label: localize('showMoreCodeActions', 'Show Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => this.toggleShowDisabled(true)
			});
		}
		return actions;
	}
}
registerSingleton(IActionWidgetService, ActionWidgetService, InstantiationType.Delayed);

interface HeaderTemplateData {
	readonly container: HTMLElement;
	readonly text: HTMLElement;
}

class HeaderRenderer implements IListRenderer<CodeActionListItemHeader, HeaderTemplateData> {

	get templateId(): string { return CodeActionListItemKind.Header; }

	renderTemplate(container: HTMLElement): HeaderTemplateData {
		container.classList.add('group-header');

		const text = document.createElement('span');
		container.append(text);

		return { container, text };
	}

	renderElement(element: CodeActionListItemHeader, _index: number, templateData: HeaderTemplateData): void {
		templateData.text.textContent = element.group.title;
	}

	disposeTemplate(_templateData: HeaderTemplateData): void {
		// noop
	}
}

const previewSelectedEventType = 'previewSelectedCodeAction';
export class CodeActionList extends Disposable {

	private readonly codeActionLineHeight = 24;
	private readonly headerLineHeight = 26;

	public readonly domNode: HTMLElement;

	private readonly list: List<ICodeActionMenuItem>;

	private readonly allMenuItems: ICodeActionMenuItem[];

	constructor(
		codeActions: readonly ActionItem[],
		showHeaders: boolean,
		private readonly onDidSelect: (action: ActionItem, options: { readonly preview: boolean }) => void,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super();

		this.domNode = document.createElement('div');
		this.domNode.classList.add('codeActionList');

		this.list = this._register(new List('codeActionWidget', this.domNode, {
			getHeight: element => element.kind === CodeActionListItemKind.Header ? this.headerLineHeight : this.codeActionLineHeight,
			getTemplateId: element => element.kind,
		}, [
			new CodeActionItemRenderer(new CodeActionKeybindingResolver(keybindingService), keybindingService),
			new HeaderRenderer(),
		], {
			keyboardSupport: false,
			accessibilityProvider: {
				getAriaLabel: element => {
					if (element.kind === CodeActionListItemKind.CodeAction) {
						let label = stripNewlines(element.action.action.title);
						if (element.action.action.disabled) {
							label = localize({ key: 'customCodeActionWidget.labels', comment: ['Code action labels for accessibility.'] }, "{0}, Disabled Reason: {1}", label, element.action.action.disabled);
						}
						return label;
					}
					return null;
				},
				getWidgetAriaLabel: () => localize({ key: 'customCodeActionWidget', comment: ['A Code Action Option'] }, "Code Action Widget"),
				getRole: () => 'option',
				getWidgetRole: () => 'code-action-widget'
			}
		}));

		this._register(this.list.onMouseClick(e => this.onListClick(e)));
		this._register(this.list.onMouseOver(e => this.onListHover(e)));
		this._register(this.list.onDidChangeFocus(() => this.list.domFocus()));
		this._register(this.list.onDidChangeSelection(e => this.onListSelection(e)));

		this.allMenuItems = this.toMenuItems(codeActions, showHeaders);
		this.list.splice(0, this.list.length, this.allMenuItems);

		this.focusNext();
	}

	public layout(minWidth: number): number {
		// Updating list height, depending on how many separators and headers there are.
		const numHeaders = this.allMenuItems.filter(item => item.kind === CodeActionListItemKind.Header).length;
		const height = this.allMenuItems.length * this.codeActionLineHeight;
		const heightWithHeaders = height + numHeaders * this.headerLineHeight - numHeaders * this.codeActionLineHeight;
		this.list.layout(heightWithHeaders);

		// For finding width dynamically (not using resize observer)
		const itemWidths: number[] = this.allMenuItems.map((_, index): number => {
			const element = document.getElementById(this.list.getElementID(index));
			if (element) {
				element.style.width = 'auto';
				const width = element.getBoundingClientRect().width;
				element.style.width = '';
				return width;
			}
			return 0;
		});

		// resize observer - can be used in the future since list widget supports dynamic height but not width
		const width = Math.max(...itemWidths, minWidth);
		this.list.layout(heightWithHeaders, width);

		this.domNode.style.height = `${heightWithHeaders}px`;

		this.list.domFocus();
		return width;
	}

	public focusPrevious() {
		this.list.focusPrevious(1, true, undefined, element => element.kind === CodeActionListItemKind.CodeAction && !element.action.action.disabled);
	}

	public focusNext() {
		this.list.focusNext(1, true, undefined, element => element.kind === CodeActionListItemKind.CodeAction && !element.action.action.disabled);
	}

	public acceptSelected(options?: { readonly preview?: boolean }) {
		const focused = this.list.getFocus();
		if (focused.length === 0) {
			return;
		}

		const focusIndex = focused[0];
		const element = this.list.element(focusIndex);
		if (element.kind !== CodeActionListItemKind.CodeAction || element.action.action.disabled) {
			return;
		}

		const event = new UIEvent(options?.preview ? previewSelectedEventType : 'acceptSelectedCodeAction');
		this.list.setSelection([focusIndex], event);
	}

	private onListSelection(e: IListEvent<ICodeActionMenuItem>): void {
		if (!e.elements.length) {
			return;
		}

		const element = e.elements[0];
		if (element.kind === CodeActionListItemKind.CodeAction && !element.action.action.disabled) {
			this.onDidSelect(element.action, { preview: e.browserEvent?.type === previewSelectedEventType });
		} else {
			this.list.setSelection([]);
		}
	}

	private onListHover(e: IListMouseEvent<ICodeActionMenuItem>): void {
		this.list.setFocus(typeof e.index === 'number' ? [e.index] : []);
	}

	private onListClick(e: IListMouseEvent<ICodeActionMenuItem>): void {
		if (e.element && e.element.kind === CodeActionListItemKind.CodeAction && e.element.action.action.disabled) {
			this.list.setFocus([]);
		}
	}

	private toMenuItems(inputCodeActions: readonly ActionItem[], showHeaders: boolean): ICodeActionMenuItem[] {
		if (!showHeaders) {
			return inputCodeActions.map((action): ICodeActionMenuItem => ({ kind: CodeActionListItemKind.CodeAction, action, group: uncategorizedCodeActionGroup }));
		}

		// Group code actions
		const menuEntries = codeActionGroups.map(group => ({ group, actions: [] as ActionItem[] }));

		for (const action of inputCodeActions) {
			const kind = action.action.kind ? new CodeActionKind(action.action.kind) : CodeActionKind.None;
			for (const menuEntry of menuEntries) {
				if (menuEntry.group.kind?.contains(kind)) {
					menuEntry.actions.push(action);
					break;
				}
			}
		}

		const allMenuItems: ICodeActionMenuItem[] = [];
		for (const menuEntry of menuEntries) {
			if (menuEntry.actions.length) {
				allMenuItems.push({ kind: CodeActionListItemKind.Header, group: menuEntry.group });
				for (const action of menuEntry.actions) {
					allMenuItems.push({ kind: CodeActionListItemKind.CodeAction, action, group: menuEntry.group });
				}
			}
		}

		return allMenuItems;
	}
}
enum CodeActionListItemKind {
	CodeAction = 'action',
	Header = 'header'
}

interface CodeActionListItemCodeAction {
	readonly kind: CodeActionListItemKind.CodeAction;
	readonly action: ActionItem;
	readonly group: CodeActionGroup;
}

interface CodeActionListItemHeader {
	readonly kind: CodeActionListItemKind.Header;
	readonly group: CodeActionGroup;
}

interface CodeActionGroup {
	readonly kind: CodeActionKind;
	readonly title: string;
	readonly icon?: { readonly codicon: Codicon; readonly color?: string };
}

type ICodeActionMenuItem = CodeActionListItemCodeAction | CodeActionListItemHeader;


export interface CodeActionShowOptions {
	readonly includeDisabledActions: boolean;
	readonly fromLightbulb?: boolean;
	readonly showHeaders?: boolean;
}

interface ICodeActionMenuTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly keybinding: KeybindingLabel;
}

function stripNewlines(str: string): string {
	return str.replace(/\r\n|\r|\n/g, ' ');
}

interface CodeActionGroup {
	readonly kind: CodeActionKind;
	readonly title: string;
	readonly icon?: { readonly codicon: Codicon; readonly color?: string };
}

const uncategorizedCodeActionGroup = Object.freeze<CodeActionGroup>({ kind: CodeActionKind.Empty, title: localize('codeAction.widget.id.more', 'More Actions...') });

const codeActionGroups = Object.freeze<CodeActionGroup[]>([
	{ kind: CodeActionKind.QuickFix, title: localize('codeAction.widget.id.quickfix', 'Quick Fix...') },
	{ kind: CodeActionKind.RefactorExtract, title: localize('codeAction.widget.id.extract', 'Extract...'), icon: { codicon: Codicon.wrench } },
	{ kind: CodeActionKind.RefactorInline, title: localize('codeAction.widget.id.inline', 'Inline...'), icon: { codicon: Codicon.wrench } },
	{ kind: CodeActionKind.RefactorRewrite, title: localize('codeAction.widget.id.convert', 'Rewrite...'), icon: { codicon: Codicon.wrench } },
	{ kind: CodeActionKind.RefactorMove, title: localize('codeAction.widget.id.move', 'Move...'), icon: { codicon: Codicon.wrench } },
	{ kind: CodeActionKind.SurroundWith, title: localize('codeAction.widget.id.surround', 'Surround With...'), icon: { codicon: Codicon.symbolSnippet } },
	{ kind: CodeActionKind.Source, title: localize('codeAction.widget.id.source', 'Source Action...'), icon: { codicon: Codicon.symbolFile } },
	uncategorizedCodeActionGroup,
]);

class CodeActionItemRenderer implements IListRenderer<CodeActionListItemCodeAction, ICodeActionMenuTemplateData> {
	constructor(
		private readonly keybindingResolver: CodeActionKeybindingResolver,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) { }

	get templateId(): string { return CodeActionListItemKind.CodeAction; }

	renderTemplate(container: HTMLElement): ICodeActionMenuTemplateData {
		container.classList.add('code-action');

		const icon = document.createElement('div');
		icon.className = 'icon';
		container.append(icon);

		const text = document.createElement('span');
		text.className = 'title';
		container.append(text);

		const keybinding = new KeybindingLabel(container, OS);

		return { container, icon, text, keybinding };
	}

	renderElement(element: CodeActionListItemCodeAction, _index: number, data: ICodeActionMenuTemplateData): void {
		if (element.group.icon) {
			data.icon.className = element.group.icon.codicon.classNames;
			data.icon.style.color = element.group.icon.color ?? '';
		} else {
			data.icon.className = Codicon.lightBulb.classNames;
			data.icon.style.color = 'var(--vscode-editorLightBulb-foreground)';
		}

		data.text.textContent = stripNewlines(element.action.action.title);

		const binding = this.keybindingResolver.getResolver()(element.action.action);
		data.keybinding.set(binding);
		if (!binding) {
			dom.hide(data.keybinding.element);
		} else {
			dom.show(data.keybinding.element);
		}

		if (element.action.action.disabled) {
			data.container.title = element.action.action.disabled;
			data.container.classList.add('option-disabled');
		} else {
			data.container.title = localize({ key: 'label', comment: ['placeholders are keybindings, e.g "F2 to Apply, Shift+F2 to Preview"'] }, "{0} to Apply, {1} to Preview", this.keybindingService.lookupKeybinding(acceptSelectedCodeActionCommand)?.getLabel(), this.keybindingService.lookupKeybinding(previewSelectedCodeActionCommand)?.getLabel());
			data.container.classList.remove('option-disabled');
		}
	}

	disposeTemplate(_templateData: ICodeActionMenuTemplateData): void {
		// noop
	}
}
