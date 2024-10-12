/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../../base/common/event.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { TernarySearchTree } from '../../../../../base/common/ternarySearchTree.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IReplaceService } from './../replace.js';
import { IFileMatch, IPatternInfo, ITextQuery, ITextSearchPreviewOptions, resultIsMatch } from '../../../../services/search/common/search.js';

import { FileMatchImpl } from './fileMatch.js';
import { IChangeEvent, textSearchResultToMatches } from './searchTreeCommon.js';
import { IFileInstanceMatch, IFolderMatch, IFolderMatchWithResource, IFolderMatchNoRoot as IFolderMatchNoRoot, IFolderMatchWorkspaceRoot, ISearchModel, ISearchResult, isFileInstanceMatch, isFolderMatch, isFolderMatchWorkspaceRoot, ITextSearchHeading, isFolderMatchNoRoot } from './ISearchTreeBase.js';
import { NotebookEditorWidget } from '../../../notebook/browser/notebookEditorWidget.js';
import { isINotebookFileMatchNoModel } from '../../common/searchNotebookHelpers.js';
import { isNotebookFileMatch } from '../notebookSearch/notebookSearchModel.js';
import { isINotebookFileMatchWithModel, getIDFromINotebookCellMatch } from '../notebookSearch/searchNotebookHelpers.js';


export class FolderMatchImpl extends Disposable implements IFolderMatch {

	protected _onChange = this._register(new Emitter<IChangeEvent>());
	readonly onChange: Event<IChangeEvent> = this._onChange.event;

	private _onDispose = this._register(new Emitter<void>());
	readonly onDispose: Event<void> = this._onDispose.event;

	protected _fileMatches: ResourceMap<IFileInstanceMatch>;
	protected _folderMatches: ResourceMap<IFolderMatchWithResource>;
	protected _folderMatchesMap: TernarySearchTree<URI, IFolderMatchWithResource>;
	protected _unDisposedFileMatches: ResourceMap<IFileInstanceMatch>;
	protected _unDisposedFolderMatches: ResourceMap<IFolderMatchWithResource>;
	private _replacingAll: boolean = false;
	private _name: Lazy<string>;

	constructor(
		protected _resource: URI | null,
		private _id: string,
		protected _index: number,
		protected _query: ITextQuery,
		private _parent: ITextSearchHeading | IFolderMatch,
		private _searchResult: ISearchResult,
		private _closestRoot: IFolderMatchWorkspaceRoot | null,
		@IReplaceService private readonly replaceService: IReplaceService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService
	) {
		super();
		this._fileMatches = new ResourceMap<IFileInstanceMatch>();
		this._folderMatches = new ResourceMap<IFolderMatchWithResource>();
		this._folderMatchesMap = TernarySearchTree.forUris<IFolderMatchWithResource>(key => this.uriIdentityService.extUri.ignorePathCasing(key));
		this._unDisposedFileMatches = new ResourceMap<IFileInstanceMatch>();
		this._unDisposedFolderMatches = new ResourceMap<IFolderMatchWithResource>();
		this._name = new Lazy(() => this.resource ? labelService.getUriBasenameLabel(this.resource) : '');
	}

	get searchModel(): ISearchModel {
		return this._searchResult.searchModel;
	}

	get showHighlights(): boolean {
		return this._parent.showHighlights;
	}

	get closestRoot(): IFolderMatchWorkspaceRoot | null {
		return this._closestRoot;
	}

	set replacingAll(b: boolean) {
		this._replacingAll = b;
	}

	id(): string {
		return this._id;
	}

	get resource(): URI | null {
		return this._resource;
	}

	index(): number {
		return this._index;
	}

	name(): string {
		return this._name.value;
	}

	parent(): ITextSearchHeading | IFolderMatch {
		return this._parent;
	}

	get hasChildren(): boolean {
		return this._fileMatches.size > 0 || this._folderMatches.size > 0;
	}

	bindModel(model: ITextModel): void {
		const fileMatch = this._fileMatches.get(model.uri);

		if (fileMatch) {
			fileMatch.bindModel(model);
		} else {
			const folderMatch = this.getFolderMatch(model.uri);
			const match = folderMatch?.getDownstreamFileMatch(model.uri);
			match?.bindModel(model);
		}
	}

	public createIntermediateFolderMatch(resource: URI, id: string, index: number, query: ITextQuery, baseWorkspaceFolder: IFolderMatchWorkspaceRoot): IFolderMatchWithResource {
		const folderMatch = this._register(this.instantiationService.createInstance(FolderMatchWithResourceImpl, resource, id, index, query, this, this._searchResult, baseWorkspaceFolder));
		this.configureIntermediateMatch(folderMatch);
		this.doAddFolder(folderMatch);
		return folderMatch;
	}

	public configureIntermediateMatch(folderMatch: IFolderMatchWithResource) {
		const disposable = folderMatch.onChange((event) => this.onFolderChange(folderMatch, event));
		this._register(folderMatch.onDispose(() => disposable.dispose()));
	}

	clear(clearingAll = false): void {
		const changed: IFileInstanceMatch[] = this.allDownstreamFileMatches();
		this.disposeMatches();
		this._onChange.fire({ elements: changed, removed: true, added: false, clearingAll });
	}

	remove(matches: IFileInstanceMatch | IFolderMatchWithResource | (IFileInstanceMatch | IFolderMatchWithResource)[]): void {
		if (!Array.isArray(matches)) {
			matches = [matches];
		}
		const allMatches = getFileMatches(matches);
		this.doRemoveFile(allMatches);
	}

	async replace(match: FileMatchImpl): Promise<any> {
		return this.replaceService.replace([match]).then(() => {
			this.doRemoveFile([match], true, true, true);
		});
	}

	replaceAll(): Promise<any> {
		const matches = this.matches();
		return this.batchReplace(matches);
	}

	matches(): (IFileInstanceMatch | IFolderMatchWithResource)[] {
		return [...this.fileMatchesIterator(), ...this.folderMatchesIterator()];
	}

	fileMatchesIterator(): IterableIterator<IFileInstanceMatch> {
		return this._fileMatches.values();
	}

	folderMatchesIterator(): IterableIterator<IFolderMatchWithResource> {
		return this._folderMatches.values();
	}

	isEmpty(): boolean {
		return (this.fileCount() + this.folderCount()) === 0;
	}

	getDownstreamFileMatch(uri: URI): IFileInstanceMatch | null {
		const directChildFileMatch = this._fileMatches.get(uri);
		if (directChildFileMatch) {
			return directChildFileMatch;
		}

		const folderMatch = this.getFolderMatch(uri);
		const match = folderMatch?.getDownstreamFileMatch(uri);
		if (match) {
			return match;
		}

		return null;
	}

	allDownstreamFileMatches(): IFileInstanceMatch[] {
		let recursiveChildren: IFileInstanceMatch[] = [];
		const iterator = this.folderMatchesIterator();
		for (const elem of iterator) {
			recursiveChildren = recursiveChildren.concat(elem.allDownstreamFileMatches());
		}

		return [...this.fileMatchesIterator(), ...recursiveChildren];
	}

	private fileCount(): number {
		return this._fileMatches.size;
	}

	private folderCount(): number {
		return this._folderMatches.size;
	}

	count(): number {
		return this.fileCount() + this.folderCount();
	}

	recursiveFileCount(): number {
		return this.allDownstreamFileMatches().length;
	}

	recursiveMatchCount(): number {
		return this.allDownstreamFileMatches().reduce<number>((prev, match) => prev + match.count(), 0);
	}

	get query(): ITextQuery | null {
		return this._query;
	}

	doAddFile(fileMatch: IFileInstanceMatch): void {
		this._fileMatches.set(fileMatch.resource, fileMatch);
		if (this._unDisposedFileMatches.has(fileMatch.resource)) {
			this._unDisposedFileMatches.delete(fileMatch.resource);
		}
	}

	hasOnlyReadOnlyMatches(): boolean {
		return Array.from(this._fileMatches.values()).every(fm => fm.hasOnlyReadOnlyMatches());
	}

	protected uriHasParent(parent: URI, child: URI) {
		return this.uriIdentityService.extUri.isEqualOrParent(child, parent) && !this.uriIdentityService.extUri.isEqual(child, parent);
	}

	private isInParentChain(folderMatch: IFolderMatchWithResource) {

		let matchItem: IFolderMatch | ITextSearchHeading = this;
		while (isFolderMatch(matchItem)) {
			if (matchItem.id() === folderMatch.id()) {
				return true;
			}
			matchItem = matchItem.parent();
		}
		return false;
	}

	public getFolderMatch(resource: URI): IFolderMatchWithResource | undefined {
		const folderMatch = this._folderMatchesMap.findSubstr(resource);
		return folderMatch;
	}

	doAddFolder(folderMatch: IFolderMatchWithResource) {
		if (this.resource && !this.uriHasParent(this.resource, folderMatch.resource)) {
			throw Error(`${folderMatch.resource} does not belong as a child of ${this.resource}`);
		} else if (this.isInParentChain(folderMatch)) {
			throw Error(`${folderMatch.resource} is a parent of ${this.resource}`);
		}

		this._folderMatches.set(folderMatch.resource, folderMatch);
		this._folderMatchesMap.set(folderMatch.resource, folderMatch);
		if (this._unDisposedFolderMatches.has(folderMatch.resource)) {
			this._unDisposedFolderMatches.delete(folderMatch.resource);
		}
	}

	private async batchReplace(matches: (IFileInstanceMatch | IFolderMatchWithResource)[]): Promise<any> {
		const allMatches = getFileMatches(matches);

		await this.replaceService.replace(allMatches);
		this.doRemoveFile(allMatches, true, true, true);
	}

	public onFileChange(fileMatch: IFileInstanceMatch, removed = false): void {
		let added = false;
		if (!this._fileMatches.has(fileMatch.resource)) {
			this.doAddFile(fileMatch);
			added = true;
		}
		if (fileMatch.count() === 0) {
			this.doRemoveFile([fileMatch], false, false);
			added = false;
			removed = true;
		}
		if (!this._replacingAll) {
			this._onChange.fire({ elements: [fileMatch], added: added, removed: removed });
		}
	}

	public onFolderChange(folderMatch: IFolderMatchWithResource, event: IChangeEvent): void {
		if (!this._folderMatches.has(folderMatch.resource)) {
			this.doAddFolder(folderMatch);
		}
		if (folderMatch.isEmpty()) {
			this._folderMatches.delete(folderMatch.resource);
			folderMatch.dispose();
		}

		this._onChange.fire(event);
	}

	doRemoveFile(fileMatches: IFileInstanceMatch[], dispose: boolean = true, trigger: boolean = true, keepReadonly = false): void {

		const removed = [];
		for (const match of fileMatches as IFileInstanceMatch[]) {
			if (this._fileMatches.get(match.resource)) {
				if (keepReadonly && match.hasReadonlyMatches()) {
					continue;
				}
				this._fileMatches.delete(match.resource);
				if (dispose) {
					match.dispose();
				} else {
					this._unDisposedFileMatches.set(match.resource, match);
				}
				removed.push(match);
			} else {
				const folder = this.getFolderMatch(match.resource);
				if (folder) {
					folder.doRemoveFile([match], dispose, trigger);
				} else {
					throw Error(`FileMatch ${match.resource} is not located within FolderMatch ${this.resource}`);
				}
			}
		}

		if (trigger) {
			this._onChange.fire({ elements: removed, removed: true });
		}
	}

	async bindNotebookEditorWidget(editor: NotebookEditorWidget, resource: URI) {
		const fileMatch = this._fileMatches.get(resource);
		if (isNotebookFileMatch(fileMatch)) {
			if (fileMatch) {
				fileMatch.bindNotebookEditorWidget(editor);
				await fileMatch.updateMatchesForEditorWidget();
			} else {
				const folderMatches = this.folderMatchesIterator();
				for (const elem of folderMatches) {
					await elem.bindNotebookEditorWidget(editor, resource);
				}
			}
		}
	}

	addFileMatch(raw: IFileMatch[], silent: boolean, searchInstanceID: string, isAiContributed: boolean): void {
		// when adding a fileMatch that has intermediate directories
		const added: IFileInstanceMatch[] = [];
		const updated: IFileInstanceMatch[] = [];

		raw.forEach(rawFileMatch => {
			const existingFileMatch = this.getDownstreamFileMatch(rawFileMatch.resource);
			if (existingFileMatch) {

				if (rawFileMatch.results) {
					rawFileMatch
						.results
						.filter(resultIsMatch)
						.forEach(m => {
							textSearchResultToMatches(m, existingFileMatch, isAiContributed)
								.forEach(m => existingFileMatch.add(m));
						});
				}

				// add cell matches
				if (isINotebookFileMatchWithModel(rawFileMatch) || isINotebookFileMatchNoModel(rawFileMatch)) {
					rawFileMatch.cellResults?.forEach(rawCellMatch => {
						if (isNotebookFileMatch(existingFileMatch)) {
							const existingCellMatch = existingFileMatch.getCellMatch(getIDFromINotebookCellMatch(rawCellMatch));
							if (existingCellMatch) {
								existingCellMatch.addContentMatches(rawCellMatch.contentResults);
								existingCellMatch.addWebviewMatches(rawCellMatch.webviewResults);
							} else {
								existingFileMatch.addCellMatch(rawCellMatch);
							}
						}
					});
				}

				updated.push(existingFileMatch);

				if (rawFileMatch.results && rawFileMatch.results.length > 0) {
					existingFileMatch.addContext(rawFileMatch.results);
				}
			} else {
				if (isFolderMatchWorkspaceRoot(this) || isFolderMatchNoRoot(this)) {
					const fileMatch = this.createAndConfigureFileMatch(rawFileMatch, searchInstanceID);
					added.push(fileMatch);
				}
			}
		});

		const elements = [...added, ...updated];
		if (!silent && elements.length) {
			this._onChange.fire({ elements, added: !!added.length });
		}
	}

	unbindNotebookEditorWidget(editor: NotebookEditorWidget, resource: URI) {
		const fileMatch = this._fileMatches.get(resource);

		if (isNotebookFileMatch(fileMatch)) {
			if (fileMatch) {
				fileMatch.unbindNotebookEditorWidget(editor);
			} else {
				const folderMatches = this.folderMatchesIterator();
				for (const elem of folderMatches) {
					elem.unbindNotebookEditorWidget(editor, resource);
				}
			}
		}

	}

	disposeMatches(): void {
		[...this._fileMatches.values()].forEach((fileMatch: IFileInstanceMatch) => fileMatch.dispose());
		[...this._folderMatches.values()].forEach((folderMatch: IFolderMatch) => folderMatch.disposeMatches());
		[...this._unDisposedFileMatches.values()].forEach((fileMatch: IFileInstanceMatch) => fileMatch.dispose());
		[...this._unDisposedFolderMatches.values()].forEach((folderMatch: IFolderMatch) => folderMatch.disposeMatches());
		this._fileMatches.clear();
		this._folderMatches.clear();
		this._unDisposedFileMatches.clear();
		this._unDisposedFolderMatches.clear();
	}

	override dispose(): void {
		this.disposeMatches();
		this._onDispose.fire();
		super.dispose();
	}
}

export class FolderMatchWithResourceImpl extends FolderMatchImpl implements IFolderMatchWithResource {

	protected _normalizedResource: Lazy<URI>;

	constructor(_resource: URI,
		_id: string,
		_index: number,
		_query: ITextQuery,
		_parent: ITextSearchHeading | IFolderMatch,
		_searchResult: ISearchResult,
		_closestRoot: IFolderMatchWorkspaceRoot | null,
		@IReplaceService replaceService: IReplaceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService,
		@IUriIdentityService uriIdentityService: IUriIdentityService
	) {
		super(_resource, _id, _index, _query, _parent, _searchResult, _closestRoot, replaceService, instantiationService, labelService, uriIdentityService);
		this._normalizedResource = new Lazy(() => this.uriIdentityService.extUri.removeTrailingPathSeparator(this.uriIdentityService.extUri.normalizePath(
			this.resource)));
	}

	override get resource(): URI {
		return this._resource!;
	}

	get normalizedResource(): URI {
		return this._normalizedResource.value;
	}
}

/**
 * FolderMatchWorkspaceRoot => folder for workspace root
 */
export class FolderMatchWorkspaceRootImpl extends FolderMatchWithResourceImpl implements IFolderMatchWorkspaceRoot {
	constructor(_resource: URI, _id: string, _index: number, _query: ITextQuery, _parent: ITextSearchHeading, private readonly _ai: boolean,
		@IReplaceService replaceService: IReplaceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService,
		@IUriIdentityService uriIdentityService: IUriIdentityService
	) {
		super(_resource, _id, _index, _query, _parent, _parent.parent(), null, replaceService, instantiationService, labelService, uriIdentityService);
	}

	private normalizedUriParent(uri: URI): URI {
		return this.uriIdentityService.extUri.normalizePath(this.uriIdentityService.extUri.dirname(uri));
	}

	private uriEquals(uri1: URI, ur2: URI): boolean {
		return this.uriIdentityService.extUri.isEqual(uri1, ur2);
	}

	private createFileMatch(query: IPatternInfo, previewOptions: ITextSearchPreviewOptions | undefined, maxResults: number | undefined, parent: IFolderMatch, rawFileMatch: IFileMatch, closestRoot: IFolderMatchWorkspaceRoot | null, searchInstanceID: string): FileMatchImpl {
		const fileMatch =
			this.instantiationService.createInstance(
				FileMatchImpl,
				query,
				previewOptions,
				maxResults,
				parent,
				rawFileMatch,
				closestRoot
			);
		fileMatch.createMatches(this._ai);
		parent.doAddFile(fileMatch);
		const disposable = fileMatch.onChange(({ didRemove }) => parent.onFileChange(fileMatch, didRemove));
		this._register(fileMatch.onDispose(() => disposable.dispose()));
		return fileMatch;
	}

	createAndConfigureFileMatch(rawFileMatch: IFileMatch<URI>, searchInstanceID: string): FileMatchImpl {

		if (!this.uriHasParent(this.resource, rawFileMatch.resource)) {
			throw Error(`${rawFileMatch.resource} is not a descendant of ${this.resource}`);
		}

		const fileMatchParentParts: URI[] = [];
		let uri = this.normalizedUriParent(rawFileMatch.resource);

		while (!this.uriEquals(this.normalizedResource, uri)) {
			fileMatchParentParts.unshift(uri);
			const prevUri = uri;
			uri = this.uriIdentityService.extUri.removeTrailingPathSeparator(this.normalizedUriParent(uri));
			if (this.uriEquals(prevUri, uri)) {
				throw Error(`${rawFileMatch.resource} is not correctly configured as a child of ${this.normalizedResource}`);
			}
		}

		const root = this.closestRoot ?? this;
		let parent: IFolderMatchWithResource = this;
		for (let i = 0; i < fileMatchParentParts.length; i++) {
			let folderMatch: IFolderMatchWithResource | undefined = parent.getFolderMatch(fileMatchParentParts[i]);
			if (!folderMatch) {
				folderMatch = parent.createIntermediateFolderMatch(fileMatchParentParts[i], fileMatchParentParts[i].toString(), -1, this._query, root);
			}
			parent = folderMatch;
		}

		return this.createFileMatch(this._query.contentPattern, this._query.previewOptions, this._query.maxResults, parent, rawFileMatch, root, searchInstanceID);
	}
}

/**
 * BaseFolderMatch => optional resource ("other files" node)
 * FolderMatch => required resource (normal folder node)
 */
export class FolderMatchNoRootImpl extends FolderMatchImpl implements IFolderMatchNoRoot {
	constructor(_id: string, _index: number, _query: ITextQuery, _parent: ITextSearchHeading,
		@IReplaceService replaceService: IReplaceService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILabelService labelService: ILabelService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,

	) {
		super(null, _id, _index, _query, _parent, _parent.parent(), null, replaceService, instantiationService, labelService, uriIdentityService);
	}

	createAndConfigureFileMatch(rawFileMatch: IFileMatch, searchInstanceID: string): IFileInstanceMatch {
		const fileMatch = this._register(this.instantiationService.createInstance(
			FileMatchImpl,
			this._query.contentPattern,
			this._query.previewOptions,
			this._query.maxResults,
			this, rawFileMatch,
			null));
		fileMatch.createMatches(false); // currently, no support for AI results in out-of-workspace files
		this.doAddFile(fileMatch);
		const disposable = fileMatch.onChange(({ didRemove }) => this.onFileChange(fileMatch, didRemove));
		this._register(fileMatch.onDispose(() => disposable.dispose()));
		return fileMatch;
	}
}


function getFileMatches(matches: (IFileInstanceMatch | IFolderMatchWithResource)[]): IFileInstanceMatch[] {

	const folderMatches: IFolderMatchWithResource[] = [];
	const fileMatches: IFileInstanceMatch[] = [];
	matches.forEach((e) => {
		if (isFileInstanceMatch(e)) {
			fileMatches.push(e);
		} else {
			folderMatches.push(e);
		}
	});

	return fileMatches.concat(folderMatches.map(e => e.allDownstreamFileMatches()).flat());
}