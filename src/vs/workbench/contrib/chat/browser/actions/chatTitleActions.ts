/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { marked } from '../../../../../base/common/marked/marked.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ResourceNotebookCellEdit } from '../../../bulkEdit/browser/bulkCellEdits.js';
import { MENU_INLINE_CHAT_WIDGET_SECONDARY } from '../../../inlineChat/common/inlineChat.js';
import { INotebookEditor } from '../../../notebook/browser/notebookBrowser.js';
import { CellEditType, CellKind, NOTEBOOK_EDITOR_ID } from '../../../notebook/common/notebookCommon.js';
import { NOTEBOOK_IS_ACTIVE_EDITOR } from '../../../notebook/common/notebookContextKeys.js';
import { ChatAgentLocation } from '../../common/chatAgents.js';
import { CONTEXT_CHAT_LOCATION, CONTEXT_CHAT_RESPONSE_SUPPORT_ISSUE_REPORTING, CONTEXT_IN_CHAT_INPUT, CONTEXT_IN_CHAT_SESSION, CONTEXT_ITEM_ID, CONTEXT_LAST_ITEM_ID, CONTEXT_REQUEST, CONTEXT_RESPONSE, CONTEXT_RESPONSE_ERROR, CONTEXT_RESPONSE_FILTERED, CONTEXT_RESPONSE_VOTE } from '../../common/chatContextKeys.js';
import { IChatEditingService } from '../../common/chatEditingService.js';
import { ChatAgentVoteDirection, ChatAgentVoteDownReason, IChatService } from '../../common/chatService.js';
import { isRequestVM, isResponseVM } from '../../common/chatViewModel.js';
import { ChatTreeItem, IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const MarkUnhelpfulActionId = 'workbench.action.chat.markUnhelpful';

export function registerChatTitleActions() {
	registerAction2(class MarkHelpfulAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.markHelpful',
				title: localize2('interactive.helpful.label', "Helpful"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.thumbsup,
				toggled: CONTEXT_RESPONSE_VOTE.isEqualTo('up'),
				menu: [{
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.and(CONTEXT_RESPONSE, CONTEXT_RESPONSE_ERROR.negate())
				}, {
					id: MENU_INLINE_CHAT_WIDGET_SECONDARY,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.and(CONTEXT_RESPONSE, CONTEXT_RESPONSE_ERROR.negate())
				}]
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			const item = args[0];
			if (!isResponseVM(item)) {
				return;
			}

			const chatService = accessor.get(IChatService);
			chatService.notifyUserAction({
				agentId: item.agent?.id,
				command: item.slashCommand?.name,
				sessionId: item.sessionId,
				requestId: item.requestId,
				result: item.result,
				action: {
					kind: 'vote',
					direction: ChatAgentVoteDirection.Up,
					reason: undefined
				}
			});
			item.setVote(ChatAgentVoteDirection.Up);
			item.setVoteDownReason(undefined);
		}
	});

	registerAction2(class MarkUnhelpfulAction extends Action2 {
		constructor() {
			super({
				id: MarkUnhelpfulActionId,
				title: localize2('interactive.unhelpful.label', "Unhelpful"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.thumbsdown,
				toggled: CONTEXT_RESPONSE_VOTE.isEqualTo('down'),
				menu: [{
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(CONTEXT_RESPONSE)
				}, {
					id: MENU_INLINE_CHAT_WIDGET_SECONDARY,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(CONTEXT_RESPONSE, CONTEXT_RESPONSE_ERROR.negate())
				}]
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			const item = args[0];
			if (!isResponseVM(item)) {
				return;
			}

			const reason = args[1];
			if (typeof reason !== 'string') {
				return;
			}

			item.setVote(ChatAgentVoteDirection.Down);
			item.setVoteDownReason(reason as ChatAgentVoteDownReason);

			const chatService = accessor.get(IChatService);
			chatService.notifyUserAction({
				agentId: item.agent?.id,
				command: item.slashCommand?.name,
				sessionId: item.sessionId,
				requestId: item.requestId,
				result: item.result,
				action: {
					kind: 'vote',
					direction: ChatAgentVoteDirection.Down,
					reason: item.voteDownReason
				}
			});
		}
	});

	registerAction2(class ReportIssueForBugAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.reportIssueForBug',
				title: localize2('interactive.reportIssueForBug.label', "Report Issue"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.report,
				menu: [{
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					order: 3,
					when: ContextKeyExpr.and(CONTEXT_CHAT_RESPONSE_SUPPORT_ISSUE_REPORTING, CONTEXT_RESPONSE)
				}, {
					id: MENU_INLINE_CHAT_WIDGET_SECONDARY,
					group: 'navigation',
					order: 3,
					when: ContextKeyExpr.and(CONTEXT_CHAT_RESPONSE_SUPPORT_ISSUE_REPORTING, CONTEXT_RESPONSE)
				}]
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			const item = args[0];
			if (!isResponseVM(item)) {
				return;
			}

			const chatService = accessor.get(IChatService);
			chatService.notifyUserAction({
				agentId: item.agent?.id,
				command: item.slashCommand?.name,
				sessionId: item.sessionId,
				requestId: item.requestId,
				result: item.result,
				action: {
					kind: 'bug'
				}
			});
		}
	});

	registerAction2(class RetryChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.retry',
				title: localize2('chat.retry.label', "Retry"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.refresh,
				menu: [{
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					when: ContextKeyExpr.and(
						CONTEXT_RESPONSE,
						ContextKeyExpr.in(CONTEXT_ITEM_ID.key, CONTEXT_LAST_ITEM_ID.key))
				}]
			});
		}

		async run(accessor: ServicesAccessor, ...args: any[]) {
			const item = args[0];
			if (!isResponseVM(item)) {
				return;
			}

			const chatService = accessor.get(IChatService);
			const chatEditingService = accessor.get(IChatEditingService);
			const chatModel = chatService.getSession(item.sessionId);
			const chatRequests = chatModel?.getRequests();
			if (!chatRequests) {
				return;
			}
			const itemIndex = chatRequests?.findIndex(request => request.id === item.requestId);
			if (chatModel?.initialLocation === ChatAgentLocation.EditingSession) {
				const dialogService = accessor.get(IDialogService);
				const confirmation = await dialogService.confirm({
					title: localize('chat.removeLast.confirmation.title', "Do you want to retry your last edit?"),
					message: localize('chat.remove.confirmation.message', "This will also undo any edits made to your working set from this request."),
					primaryButton: localize('chat.remove.confirmation.primaryButton', "Yes"),
					type: 'info'
				});
				if (!confirmation) {
					return;
				}
				// Reset the snapshot
				const snapshotRequest = chatRequests[itemIndex];
				if (snapshotRequest) {
					await chatEditingService.restoreSnapshot(snapshotRequest.id);
				}
			}
			const request = chatModel?.getRequests().find(candidate => candidate.id === item.requestId);
			chatService.resendRequest(request!);
		}
	});

	registerAction2(class InsertToNotebookAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.insertIntoNotebook',
				title: localize2('interactive.insertIntoNotebook.label', "Insert into Notebook"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.insert,
				menu: {
					id: MenuId.ChatMessageFooter,
					group: 'navigation',
					isHiddenByDefault: true,
					when: ContextKeyExpr.and(NOTEBOOK_IS_ACTIVE_EDITOR, CONTEXT_RESPONSE, CONTEXT_RESPONSE_FILTERED.negate())
				}
			});
		}

		async run(accessor: ServicesAccessor, ...args: any[]) {
			const item = args[0];
			if (!isResponseVM(item)) {
				return;
			}

			const editorService = accessor.get(IEditorService);

			if (editorService.activeEditorPane?.getId() === NOTEBOOK_EDITOR_ID) {
				const notebookEditor = editorService.activeEditorPane.getControl() as INotebookEditor;

				if (!notebookEditor.hasModel()) {
					return;
				}

				if (notebookEditor.isReadOnly) {
					return;
				}

				const value = item.response.toString();
				const splitContents = splitMarkdownAndCodeBlocks(value);

				const focusRange = notebookEditor.getFocus();
				const index = Math.max(focusRange.end, 0);
				const bulkEditService = accessor.get(IBulkEditService);

				await bulkEditService.apply(
					[
						new ResourceNotebookCellEdit(notebookEditor.textModel.uri,
							{
								editType: CellEditType.Replace,
								index: index,
								count: 0,
								cells: splitContents.map(content => {
									const kind = content.type === 'markdown' ? CellKind.Markup : CellKind.Code;
									const language = content.type === 'markdown' ? 'markdown' : content.language;
									const mime = content.type === 'markdown' ? 'text/markdown' : `text/x-${content.language}`;
									return {
										cellKind: kind,
										language,
										mime,
										source: content.content,
										outputs: [],
										metadata: {}
									};
								})
							}
						)
					],
					{ quotableLabel: 'Insert into Notebook' }
				);
			}
		}
	});


	registerAction2(class RemoveAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.remove',
				title: localize2('chat.remove.label', "Remove Request and Response"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.x,
				precondition: CONTEXT_CHAT_LOCATION.notEqualsTo(ChatAgentLocation.EditingSession),
				keybinding: {
					primary: KeyCode.Delete,
					mac: {
						primary: KeyMod.CtrlCmd | KeyCode.Backspace,
					},
					when: ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.notEqualsTo(ChatAgentLocation.EditingSession), CONTEXT_IN_CHAT_SESSION, CONTEXT_IN_CHAT_INPUT.negate()),
					weight: KeybindingWeight.WorkbenchContrib,
				},
				menu: {
					id: MenuId.ChatMessageTitle,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.notEqualsTo(ChatAgentLocation.EditingSession), CONTEXT_REQUEST)
				}
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			let item: ChatTreeItem | undefined = args[0];
			if (!isRequestVM(item)) {
				const chatWidgetService = accessor.get(IChatWidgetService);
				const widget = chatWidgetService.lastFocusedWidget;
				item = widget?.getFocus();
			}

			if (!item) {
				return;
			}

			const chatService = accessor.get(IChatService);
			const chatModel = chatService.getSession(item.sessionId);
			if (chatModel?.initialLocation !== ChatAgentLocation.EditingSession) {
				return;
			}

			const requestId = isRequestVM(item) ? item.id :
				isResponseVM(item) ? item.requestId : undefined;

			if (requestId) {
				const chatService = accessor.get(IChatService);
				chatService.removeRequest(item.sessionId, requestId);
			}
		}
	});
}

interface MarkdownContent {
	type: 'markdown';
	content: string;
}

interface CodeContent {
	type: 'code';
	language: string;
	content: string;
}

type Content = MarkdownContent | CodeContent;

function splitMarkdownAndCodeBlocks(markdown: string): Content[] {
	const lexer = new marked.Lexer();
	const tokens = lexer.lex(markdown);

	const splitContent: Content[] = [];

	let markdownPart = '';
	tokens.forEach((token) => {
		if (token.type === 'code') {
			if (markdownPart.trim()) {
				splitContent.push({ type: 'markdown', content: markdownPart });
				markdownPart = '';
			}
			splitContent.push({
				type: 'code',
				language: token.lang || '',
				content: token.text,
			});
		} else {
			markdownPart += token.raw;
		}
	});

	if (markdownPart.trim()) {
		splitContent.push({ type: 'markdown', content: markdownPart });
	}

	return splitContent;
}
