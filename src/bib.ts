import { ButtonComponent, HoverPopover, HoverParent, Platform, FileSystemAdapter, Notice, ExtraButtonComponent, Events } from 'obsidian';
import { PDFDocumentProxy } from 'pdfjs-dist';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { genId, isCanvas, isEmbed, isHoverPopover, isNonEmbedLike, onModKeyPress, toSingleLine } from 'utils';
import { PDFViewerChild, PDFJsDestArray, TextContentItem } from 'typings';


export type AnystyleJson = Partial<{
    author: { family: string, given: string }[],
    title: string[],
    date: string[],
    year: string, // Not present in the original anystyle output
    pages: string[],
    volume: string[],
    'container-title': string[],
    'citation-number': string[],
    type: string,
}>;


export class BibliographyManager extends PDFPlusComponent {
    static readonly HOVER_LINK_SOURCE_ID = 'pdf-plus-citation-link';

    child: PDFViewerChild;
    destIdToBibText: Map<string, string>;
    destIdToParsedBib: Map<string, AnystyleJson>;
    events: Events;
    initialized: boolean;

    constructor(plugin: PDFPlus, child: PDFViewerChild) {
        super(plugin);
        this.child = child;
        this.destIdToBibText = new Map();
        this.destIdToParsedBib = new Map();
        this.events = new Events();
        this.initialized = false;
        this.init();
    }

    isEnabled() {
        const viewer = this.child.pdfViewer;
        return this.settings.actionOnCitationHover !== 'none'
            && (
                isNonEmbedLike(viewer)
                || (this.settings.enableBibInCanvas && isCanvas(viewer))
                || (this.settings.enableBibInHoverPopover && isHoverPopover(viewer))
                || (this.settings.enableBibInEmbed && isEmbed(viewer))
            );
    }

    private async init() {
        if (this.isEnabled()) {
            await this.extractBibText();
            await this.parseBibText();
        }
        this.initialized = true;
    }

    private async extractBibText() {
        return new Promise<void>((resolve) => {
            this.lib.onDocumentReady(this.child.pdfViewer, (doc) => {
                new BibliographyTextExtractor(this.plugin, doc)
                    .onExtracted((destId, bibText) => {
                        this.destIdToBibText.set(destId, bibText);
                        this.events.trigger('extracted', destId, bibText);
                    })
                    .extract()
                    .then(resolve);
            });
        });
    }

    private async parseBibText() {
        const entries = Array.from(this.destIdToBibText.entries()).filter(([_, text]) => !!text.trim());
        if (entries.length === 0) return;

        // Number each citation explicitly and separate with double newlines
        // so that AnyStyle treats each as a distinct entry and returns 'citation-number'.
        // In Springer / LNCS style, author lists end with ".: " before the title (e.g. "Díaz, J.L.: Joint Autoscaling...").
        // AnyStyle's CRF model gets confused and treats "J.L.:" as title start; replacing ".: " with ". " fixes it completely.
        const formatted = entries.map(([_, text], idx) => {
            const sanitized = text.replace(/\.:\s+/g, '. ');
            return `[${idx + 1}] ${sanitized}`;
        }).join('\n\n');
        const parsed = await this.parseBibliographyText(formatted);
        if (parsed && Array.isArray(parsed)) {
            const matchedIndices = new Set<number>();
            for (const item of parsed) {
                const citNumStr = item['citation-number']?.[0];
                if (citNumStr) {
                    const num = parseInt(citNumStr, 10);
                    if (!isNaN(num) && num >= 1 && num <= entries.length) {
                        const index = num - 1;
                        const destId = entries[index][0];
                        this.destIdToParsedBib.set(destId, item);
                        this.events.trigger('parsed', destId, item);
                        matchedIndices.add(index);
                    }
                }
            }

            // Fallback for any unmapped entries
            if (matchedIndices.size === 0) {
                for (let i = 0; i < Math.min(parsed.length, entries.length); i++) {
                    const destId = entries[i][0];
                    this.destIdToParsedBib.set(destId, parsed[i]);
                    this.events.trigger('parsed', destId, parsed[i]);
                }
            }
        }
    }

    spawnBibPopoverOnModKeyDown(destId: string, hoverParent: HoverParent, event: MouseEvent, targetEl: HTMLElement) {
        const spawnBibPopover = () => {
            const hoverPopover = new HoverPopover(hoverParent, targetEl, 200);
            hoverPopover.hoverEl.addClass('pdf-plus-bib-popover');
            const bibContainerEl = hoverPopover.hoverEl.createDiv();
            hoverPopover.addChild(
                new BibliographyDom(this, destId, bibContainerEl)
            );
        };

        if (this.plugin.requireModKeyForLinkHover(BibliographyManager.HOVER_LINK_SOURCE_ID)) {
            onModKeyPress(event, targetEl, spawnBibPopover);
        } else {
            spawnBibPopover();
        }
    }

    getGoogleScholarSearchUrlFromDest(destId: string) {
        let searchText = '';

        // Generated the search text by extracting important information from the bibliography text
        // Heuristically, this gives better search results than just searching the entire bibliography text.
        const parsed = this.destIdToParsedBib.get(destId);
        if (parsed) {
            const { author, title, year, 'container-title': containerTitle } = parsed;
            if (title) searchText += `${title[0]}`;
            if (author) searchText += ' ' + author.map((a) => a.family).join(' ');
            if (year) searchText += ` ${year}`;
            if (containerTitle) searchText += ` ${containerTitle[0]}`;
        } else {
            searchText = this.destIdToBibText.get(destId) ?? '';
        }

        return searchText
            ? `https://scholar.google.com/scholar?hl=en&as_sdt=0%2C5&q=${encodeURIComponent(searchText)}`
            : null;
    }

    /** Parse a bibliography text using Anystyle. */
    async parseBibliographyText(text: string): Promise<AnystyleJson[] | null> {
        const { app, plugin, settings } = this;

        const anystylePath = settings.anystylePath;
        if (!anystylePath) return null;

        const anystyleDirPath = plugin.getAnyStyleInputDir();
        // Node.js is available only in the desktop app
        if (Platform.isDesktopApp && app.vault.adapter instanceof FileSystemAdapter && anystyleDirPath) {
            // Anystyle only accepts a file as input, so we need to write the text to a file.
            // We store the file under the `anystyle` folder in the plugin's directory to avoid cluttering the vault.
            const anystyleDirFullPath = app.vault.adapter.getFullPath(anystyleDirPath);
            await FileSystemAdapter.mkdir(anystyleDirFullPath);

            const anystyleInputPath = anystyleDirPath + `/${genId()}.txt`;
            const anystyleInputFullPath = app.vault.adapter.getFullPath(anystyleInputPath);
            await app.vault.adapter.write(anystyleInputPath, text);
            // Clean up the file when this PDF viewer is unloaded
            this.register(() => app.vault.adapter.remove(anystyleInputPath));

            // eslint-disable-next-line @typescript-eslint/no-require-imports 
            const { spawn } = require('child_process') as typeof import('child_process');

            return new Promise<any>((resolve) => {
                const anystyleProcess = spawn(anystylePath, ['parse', anystyleInputFullPath]);
                let resultJson = '';
                anystyleProcess.stdout.on('data', (resultBuffer: Buffer | null) => {
                    if (resultBuffer) {
                        resultJson += resultBuffer.toString();
                        return;
                    }
                    resolve(null);
                });
                anystyleProcess.on('error', (err: Error & { code: string }) => {
                    if ('code' in err && err.code === 'ENOENT') {
                        const msg = `${plugin.manifest.name}: AnyStyle not found at the path "${anystylePath}".`;
                        if (plugin.settings.anystylePath) {
                            const notice = new Notice(msg, 8000);
                            notice.noticeEl.appendText(' Click ');
                            notice.noticeEl.createEl('a', { text: 'here' }, (anchorEl) => {
                                anchorEl.addEventListener('click', () => {
                                    plugin.openSettingTab().scrollTo('anystylePath');
                                });
                            });
                            notice.noticeEl.appendText(' to update the path.');
                            console.error(msg);
                        }
                        else console.warn(msg);
                        return resolve(null);
                    }
                });
                anystyleProcess.on('close', (code) => {
                    if (code) return resolve(null);

                    try {
                        const results = JSON.parse(resultJson);

                        if (Array.isArray(results)) {
                            // Add 'year' entry to each result
                            for (const result of results) {
                                for (const date of result.date ?? []) {
                                    const yearMatch = date.match(/\d{4}/);
                                    if (yearMatch) {
                                        result.year = yearMatch[0];
                                        break;
                                    }
                                }
                            }
                            return resolve(results);
                        }
                    } catch (e) {
                        console.error(`${plugin.manifest.name}: Failed to parse AnyStyle output`, e, resultJson);
                    }

                    resolve(null);
                });
            });
        }

        return null;
    }


    on(name: 'extracted', callback: (destId: string, bibText: string) => any, ctx?: any): ReturnType<Events['on']>;
    on(name: 'parsed', callback: (destId: string, parsedBib: string) => any, ctx?: any): ReturnType<Events['on']>;
    on(name: string, callback: (...args: any[]) => any, ctx?: any) {
        return this.events.on(name, callback, ctx);
    }
}


function parseDestCoords(destArray: PDFJsDestArray): { top: number | null, left: number | null } {
    if (!destArray || destArray.length < 2 || !destArray[1]) {
        return { top: null, left: null };
    }
    const name = destArray[1].name;
    if (name === 'XYZ') {
        return {
            left: typeof destArray[2] === 'number' ? destArray[2] : null,
            top: typeof destArray[3] === 'number' ? destArray[3] : null,
        };
    }
    if (name === 'FitBH' || name === 'FitH') {
        return {
            left: null,
            top: typeof destArray[2] === 'number' ? destArray[2] : null,
        };
    }
    if (name === 'FitR') {
        return {
            left: typeof destArray[2] === 'number' ? destArray[2] : null,
            top: typeof destArray[5] === 'number' ? destArray[5] : null,
        };
    }
    return { top: null, left: null };
}


class BibliographyTextExtractor {
    plugin: PDFPlus;
    doc: PDFDocumentProxy;
    pageRefToTextContentItemsPromise: Record<string, Promise<TextContentItem[]> | undefined>;
    onExtractedCallback?: (destId: string, bibText: string) => any;

    constructor(plugin: PDFPlus, doc: PDFDocumentProxy) {
        this.plugin = plugin;
        this.doc = doc;
        this.pageRefToTextContentItemsPromise = {};
    }

    onExtracted(callback: BibliographyTextExtractor['onExtractedCallback']) {
        this.onExtractedCallback = callback;
        return this;
    }

    async extract() {
        const dests = await this.doc.getDestinations();
        const pageToDests: Map<string, { destId: string; destArray: PDFJsDestArray; top: number | null; left: number | null }[]> = new Map();

        for (const destId in dests) {
            if (this.plugin.lib.isCitationId(destId)) {
                const destArray = dests[destId] as PDFJsDestArray;
                const pageRefStr = JSON.stringify(destArray[0]);
                const coords = parseDestCoords(destArray);
                let list = pageToDests.get(pageRefStr);
                if (!list) {
                    list = [];
                    pageToDests.set(pageRefStr, list);
                }
                list.push({ destId, destArray, top: coords.top, left: coords.left });
            }
        }

        const promises: Promise<void>[] = [];

        for (const list of pageToDests.values()) {
            // Sort destinations on the page from top to bottom (descending Y)
            list.sort((a, b) => {
                if (a.top !== null && b.top !== null) {
                    return b.top - a.top;
                }
                return 0;
            });

            for (let i = 0; i < list.length; i++) {
                const entry = list[i];
                // Next citation destination on this page provides a natural lower boundary
                const nextEntry = i + 1 < list.length ? list[i + 1] : undefined;

                promises.push(
                    this.extractBibTextForDest(entry.destArray, nextEntry?.destArray)
                        .then((bibInfo) => {
                            if (bibInfo) {
                                this.onExtractedCallback?.(entry.destId, bibInfo.text);
                            }
                        })
                );
            }
        }

        await Promise.all(promises);
    }

    /** Get `TextContentItem`s contained in the specified page. This method avoids fetching the same info multiple times. */
    async getTextContentItemsFromPageRef(pageRef: PDFJsDestArray[0]) {
        const refStr = JSON.stringify(pageRef);

        return this.pageRefToTextContentItemsPromise[refStr] ?? (
            this.pageRefToTextContentItemsPromise[refStr] = (async () => {
                const pageNumber = await this.doc.getPageIndex(pageRef) + 1;
                const page = await this.doc.getPage(pageNumber);
                const items = (await page.getTextContent()).items as TextContentItem[];
                return items;
            })()
        );
    }

    async extractBibTextForDest(destArray: PDFJsDestArray, nextDestArray?: PDFJsDestArray) {
        const pageRef = destArray[0];
        const items = await this.getTextContentItemsFromPageRef(pageRef);
        if (!items || items.length === 0) return null;

        const { top, left } = parseDestCoords(destArray);
        if (top === null) return null;

        const nextCoords = nextDestArray ? parseDestCoords(nextDestArray) : null;
        const nextTop = nextCoords?.top ?? null;
        const nextLeft = nextCoords?.left ?? null;

        // Locate the starting item:
        // In PDF coordinates, transform[5] is the baseline Y (grows upwards).
        // If 'top' is placed at the baseline or slightly above, we don't discard
        // the first line as long as its baseline is within a reasonable tolerance of 'top'.
        const beginIndex = items.findIndex((item: TextContentItem) => {
            if (!item.str || !item.str.trim()) return false;
            const fontSize = item.height || Math.abs(item.transform[3]) || item.transform[0] || 10;
            const itemBaseline = item.transform[5];
            const itemLeft = item.transform[4];

            // If baseline is well above top, it belongs to a preceding line
            if (itemBaseline > top + Math.max(fontSize * 0.5, 4)) {
                return false;
            }

            // If left is specified, ensure it's not from a preceding column far to the left
            if (left !== null && itemLeft < left - 15) {
                return false;
            }

            return true;
        });

        if (beginIndex === -1) return null;

        const beginItem = items[beginIndex];
        const beginFontSize = beginItem.height || Math.abs(beginItem.transform[3]) || beginItem.transform[0] || 10;
        let minLeft = beginItem.transform[4];
        let hasHangingIndent = false;

        const bibTextItems: TextContentItem[] = [beginItem];
        let fullText = beginItem.str;
        let prevItem = beginItem;

        // Check if next destination is in the same column
        const sameColumn = (left === null || nextLeft === null || Math.abs(left - nextLeft) < 100);

        for (let idx = beginIndex + 1; idx < items.length; idx++) {
            const item = items[idx];
            if (!item || !item.str) continue;

            const itemBaseline = item.transform[5];
            const itemLeft = item.transform[4];
            const itemFontSize = item.height || Math.abs(item.transform[3]) || item.transform[0] || 10;
            const isNewLine = itemBaseline < prevItem.transform[5] - 3;

            // 1. Boundary from next known citation destination on the same page/column
            if (nextTop !== null && sameColumn && itemBaseline <= nextTop + 2) {
                break;
            }

            // 2. Abrupt jump upwards (column switch or header)
            if (itemBaseline > prevItem.transform[5] + 20) {
                break;
            }

            // 3. Jump to another column horizontally
            if (left !== null && Math.abs(itemLeft - left) > 200 && isNewLine) {
                break;
            }

            if (isNewLine) {
                const trimmedStr = item.str.trim();

                // 4. Starts with a new citation enumeration/key?
                // e.g. [2], [15], (2), 2., [Smith20]
                if (/^\[\d+\]/.test(trimmedStr) || /^\(\d+\)/.test(trimmedStr) || /^\d+\.\s+/.test(trimmedStr) || /^\[[A-Za-z0-9+]+\s*\]/.test(trimmedStr)) {
                    break;
                }

                // 5. True hanging indent detection:
                // Only trigger if we previously observed indented lines (itemLeft >= minLeft + 6)
                // and this line returns back to the original left margin:
                if (hasHangingIndent && itemLeft <= minLeft + 3) {
                    break;
                }

                if (itemLeft >= minLeft + 6) {
                    hasHangingIndent = true;
                } else if (itemLeft < minLeft) {
                    minLeft = itemLeft;
                }

                // 6. Large vertical gap between paragraphs (separated bibliography entries)
                const verticalGap = prevItem.transform[5] - itemBaseline;
                if (verticalGap > Math.max(beginFontSize, itemFontSize) * 2.2) {
                    break;
                }

                if (fullText.endsWith('-')) {
                    fullText = fullText.slice(0, -1) + trimmedStr;
                } else if (trimmedStr.startsWith('.') || trimmedStr.startsWith(',')) {
                    fullText = fullText.trimEnd() + trimmedStr;
                } else {
                    fullText += ' ' + trimmedStr;
                }
            } else {
                // Same line
                const trimmedStr = item.str;
                if (trimmedStr.startsWith('.') || trimmedStr.startsWith(',') || trimmedStr.startsWith(';') || trimmedStr.startsWith(':')) {
                    fullText = fullText.trimEnd() + trimmedStr;
                } else if (!fullText.endsWith(' ') && !trimmedStr.startsWith(' ')) {
                    fullText += ' ' + trimmedStr;
                } else {
                    fullText += trimmedStr;
                }
            }

            bibTextItems.push(item);
            prevItem = item;
        }

        // Clean initial enumeration: [1], (1), 1., [Author20]
        let cleaned = fullText.trim();
        cleaned = cleaned.replace(/^\[\d+\]\s*/, '');
        cleaned = cleaned.replace(/^\(\d+\)\s*/, '');
        cleaned = cleaned.replace(/^\d+\.\s*/, '');
        cleaned = cleaned.replace(/^\[[A-Za-z0-9+]+\s*\]\s*/, '');

        cleaned = normalizeLatexDiacritics(cleaned);

        // Repair URLs split across lines (e.g. "https://doi.org/10.1007/ s10723-...")
        cleaned = cleaned.replace(/(https?:\/\/[^\s]+)\s+([^\s]+)/g, (match, p1, p2) => {
            if (p1.endsWith('/') || p1.endsWith('-')) return p1 + p2;
            return match;
        });

        return { text: toSingleLine(cleaned), items: bibTextItems };
    }
}


export function normalizeLatexDiacritics(str: string): string {
    if (!str) return str;

    // Dotless i and j
    let s = str.replace(/\u0131/g, 'i').replace(/\u0237/g, 'j');

    // Common LaTeX ligatures
    s = s.replace(/\uFB00/g, 'ff')
        .replace(/\uFB01/g, 'fi')
        .replace(/\uFB02/g, 'fl')
        .replace(/\uFB03/g, 'ffi')
        .replace(/\uFB04/g, 'ffl')
        .replace(/\uFB05/g, 'ft')
        .replace(/\uFB06/g, 'st');

    const acuteMap: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', y: 'ý', Y: 'Ý' };
    const graveMap: Record<string, string> = { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' };
    const tildeMap: Record<string, string> = { n: 'ñ', N: 'Ñ', a: 'ã', o: 'õ', A: 'Ã', O: 'Õ' };
    const dieresisMap: Record<string, string> = { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', y: 'ÿ', Y: 'Ÿ' };
    const circumflexMap: Record<string, string> = { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' };

    /* eslint-disable no-misleading-character-class */
    // Acute: \u00B4, \u0301, \u02CA
    s = s.replace(/(\S)\s+([\u00B4\u0301\u02CA])\s*([aeiouyAEIOUY])/g, (_, prev, _acc, v) => prev + (acuteMap[v] || v));
    s = s.replace(/([\u00B4\u0301\u02CA])\s*([aeiouyAEIOUY])/g, (_, _acc, v) => acuteMap[v] || v);
    s = s.replace(/([aeiouyAEIOUY])\s*([\u00B4\u0301\u02CA])\s*(\S)/g, (_, v, _acc, next) => (acuteMap[v] || v) + next);
    s = s.replace(/([aeiouyAEIOUY])\s*[\u00B4\u0301\u02CA]/g, (_, v) => acuteMap[v] || v);

    // Tilde: \u0303, \u02DC, ~
    s = s.replace(/(\S)\s+([\u0303\u02DC~])\s*([naoNAO])/g, (_, prev, _acc, v) => prev + (tildeMap[v] || v));
    s = s.replace(/([\u0303\u02DC~])\s*([naoNAO])/g, (_, _acc, v) => tildeMap[v] || v);
    s = s.replace(/([naoNAO])\s*([\u0303\u02DC~])\s*(\S)/g, (_, v, _acc, next) => (tildeMap[v] || v) + next);
    s = s.replace(/([naoNAO])\s*[\u0303\u02DC~]/g, (_, v) => tildeMap[v] || v);

    // Dieresis: \u00A8, \u0308
    s = s.replace(/(\S)\s+([\u00A8\u0308])\s*([aeiouAEIOU])/g, (_, prev, _acc, v) => prev + (dieresisMap[v] || v));
    s = s.replace(/([\u00A8\u0308])\s*([aeiouAEIOU])/g, (_, _acc, v) => dieresisMap[v] || v);
    s = s.replace(/([aeiouAEIOU])\s*([\u00A8\u0308])\s*(\S)/g, (_, v, _acc, next) => (dieresisMap[v] || v) + next);
    s = s.replace(/([aeiouAEIOU])\s*[\u00A8\u0308]/g, (_, v) => dieresisMap[v] || v);

    // Grave: \u0060, \u0300
    s = s.replace(/(\S)\s+([\u0060\u0300])\s*([aeiouAEIOU])/g, (_, prev, _acc, v) => prev + (graveMap[v] || v));
    s = s.replace(/([\u0060\u0300])\s*([aeiouAEIOU])/g, (_, _acc, v) => graveMap[v] || v);
    s = s.replace(/([aeiouAEIOU])\s*([\u0060\u0300])\s*(\S)/g, (_, v, _acc, next) => (graveMap[v] || v) + next);
    s = s.replace(/([aeiouAEIOU])\s*[\u0060\u0300]/g, (_, v) => graveMap[v] || v);

    // Circumflex: \u02C6, \u0302, ^
    s = s.replace(/(\S)\s+([\u02C6\u0302^])\s*([aeiouAEIOU])/g, (_, prev, _acc, v) => prev + (circumflexMap[v] || v));
    s = s.replace(/([\u02C6\u0302^])\s*([aeiouAEIOU])/g, (_, _acc, v) => circumflexMap[v] || v);
    s = s.replace(/([aeiouAEIOU])\s*([\u02C6\u0302^])\s*(\S)/g, (_, v, _acc, next) => (circumflexMap[v] || v) + next);
    s = s.replace(/([aeiouAEIOU])\s*[\u02C6\u0302^]/g, (_, v) => circumflexMap[v] || v);
    /* eslint-enable no-misleading-character-class */

    return s.normalize('NFC');
}


export class BibliographyDom extends PDFPlusComponent {
    containerEl: HTMLElement;
    destId: string;
    bib: BibliographyManager;

    constructor(bib: BibliographyManager, destId: string, containerEl: HTMLElement) {
        super(bib.plugin);
        this.bib = bib;
        this.destId = destId;
        this.containerEl = containerEl;
        this.containerEl.addClass('pdf-plus-bib');
    }

    get child() {
        return this.bib.child;
    }

    renderParsedBib(parsed: AnystyleJson) {
        const { author, title, year, 'container-title': containerTitle } = parsed;

        if (author || title) {
            this.containerEl.createDiv('', (el) => {
                if (title && title.length > 0) {
                    el.createDiv('bib-title', (el) => {
                        // Strip any residual author initials accidentally classified as title prefix (e.g. "J.L.: Title")
                        const cleanTitle = title[0].replace(/^([A-Z]\.(?:\s*[A-Z]\.)*):\s*/, '');
                        el.setText(normalizeLatexDiacritics(cleanTitle));
                    });
                }
                if (author || year) {
                    el.createDiv('bib-author-year', (el) => {
                        if (author) {
                            const authorText = author
                                .map((a) => {
                                    let name = '';
                                    if (a.given) name += a.given;
                                    if (a.family) name += (name ? ' ' : '') + a.family;
                                    return name.trim();
                                })
                                .filter((name) => name)
                                .join(', ');
                            el.appendText(normalizeLatexDiacritics(authorText));
                        }
                        if (year) {
                            el.appendText(author ? ` (${year})` : `(${year})`);
                        }
                    });
                }
                if (containerTitle && containerTitle.length > 0) {
                    el.createDiv('bib-container-title', (el) => {
                        el.setText(normalizeLatexDiacritics(containerTitle[0]));
                    });
                }
            });
            return true;
        }

        return false;
    }

    async onload() {
        await this.render();
    }

    async render() {
        this.containerEl.empty();
        let done = false;

        const parsed = this.bib.destIdToParsedBib.get(this.destId);
        if (parsed) {
            done = this.renderParsedBib(parsed);
        }
        if (!done) {
            const bibText = this.bib.destIdToBibText.get(this.destId);

            if (bibText) {
                this.containerEl.createDiv({ text: bibText });
                if (Platform.isDesktopApp && this.settings.anystylePath) {
                    this.registerRenderOn('parsed');
                }
            } else {
                if (this.bib.initialized) {
                    this.containerEl.createDiv({ text: 'No bibliography found' });
                } else {
                    this.containerEl.createDiv({ text: 'Loading...' });
                    this.registerRenderOn('extracted');
                }
            }
        }

        this.containerEl.createDiv('button-container', (el) => {
            new ButtonComponent(el)
                .setButtonText('Google Scholar')
                .onClick(() => {
                    const url = this.bib.getGoogleScholarSearchUrlFromDest(this.destId);
                    if (!url) {
                        new Notice(`${this.plugin.manifest.name}: ${this.bib.initialized ? 'No bibliography found' : 'Still loading the bibliography information. Please try again later.'}`);
                        return;
                    }
                    window.open(url);
                });
            new ExtraButtonComponent(el)
                .setIcon('lucide-settings')
                .setTooltip('Customize...')
                .onClick(() => {
                    this.plugin.openSettingTab().scrollToHeading('citation');
                });
        });
    }

    registerRenderOn(eventName: 'parsed' | 'extracted') {
        // @ts-ignore
        const eventRef = this.bib.on(eventName, (destId) => {
            if (destId === this.destId) {
                this.render();
                this.bib.events.offref(eventRef);
            }
        });
        this.registerEvent(eventRef);
    }

    onunload() {
        this.containerEl.empty();
    }
}
