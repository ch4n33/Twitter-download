/*!
 * Derived from Google Material Symbols: download and download_done.
 * Licensed under Apache-2.0; see licenses/material-symbols-Apache-2.0.txt.
 * Modified: scaled and positioned download_done with a small lower-left download
 * badge. The original Google path geometry is retained without redrawing.
 * Sources: https://github.com/google/material-design-icons/tree/master/symbols/web
 */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DOWNLOAD = 'M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z';
const DONE = 'M382-320 155-547l57-57 170 170 366-366 57 57-423 423ZM200-160v-80h560v80H200Z';

export function makeDownloadIcon(document: Document, size: number, saved = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'currentColor');
  const addPath = (geometry: string, transform?: string) => {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', geometry);
    if (transform) path.setAttribute('transform', transform);
    svg.append(path);
  };
  if (saved) {
    addPath(DONE, 'translate(160 -100) scale(.82)');
    addPath(DOWNLOAD, 'translate(-15 45) scale(.42)');
  } else addPath(DOWNLOAD);
  return svg;
}
