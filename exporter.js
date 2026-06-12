// EDM Builder — HTML + ZIP exporter
// Produces Outlook-safe nested-table HTML.
// Two modes:
//   buildHTML(state, { embedImages: true })  → preview (base64 data URLs)
//   exportZip(state)                          → downloadable .zip with /images/ folder

(function () {
  function getCellThumb(cell) {
    const href = cell.href || (cell._srcSlice && cell._srcSlice.href);
    const useThumb = cell.useThumb || (cell._srcSlice && cell._srcSlice.useThumb);
    if (!href || !useThumb || !window.getThumbForSlice) return null;
    return window.getThumbForSlice({ href, useThumb: true });
  }

  function escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Cut a slice out of the source image onto a canvas.
  // Reuses a single offscreen canvas to avoid exhausting browser canvas memory
  // (creating many large canvases simultaneously causes toDataURL/toBlob to fail silently).
  let _sliceCanvas = null;
  let _sliceCtx = null;

  function getSliceCanvas(w, h) {
    if (!_sliceCanvas) {
      _sliceCanvas = document.createElement('canvas');
      _sliceCtx = _sliceCanvas.getContext('2d');
    }
    _sliceCanvas.width = w;
    _sliceCanvas.height = h;
    return { canvas: _sliceCanvas, ctx: _sliceCtx };
  }

  function releaseSliceCanvas() {
    if (_sliceCanvas) { _sliceCanvas.width = _sliceCanvas.height = 1; }
  }

  function sliceToCanvas(image, s, outW, outH, annotations, thumbImg) {
    const w = outW || s.w;
    const h = outH || s.h;
    const { canvas, ctx } = getSliceCanvas(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (thumbImg && thumbImg.naturalWidth) {
      // Cover-fit the video thumbnail into the slice
      const tAR = thumbImg.naturalWidth / thumbImg.naturalHeight;
      const sAR = w / h;
      let sx, sy, sw, sh;
      if (tAR > sAR) {
        sh = thumbImg.naturalHeight;
        sw = sh * sAR;
        sx = (thumbImg.naturalWidth - sw) / 2; sy = 0;
      } else {
        sw = thumbImg.naturalWidth;
        sh = sw / sAR;
        sx = 0; sy = (thumbImg.naturalHeight - sh) / 2;
      }
      ctx.drawImage(thumbImg, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      ctx.drawImage(image, s.x, s.y, s.w, s.h, 0, 0, w, h);
    }
    // Burn text annotations that fall within this slice
    if (annotations && annotations.length) {
      const sx = w / s.w;
      const sy = h / s.h;
      ctx.textBaseline = 'top';
      annotations.forEach(a => {
        if (!a.text) return;
        const fs = a.fontSize || 16;
        const lines = a.text.split('\n');
        const lineH = fs * 1.4;
        // Annotation bounding box in image coords (approx)
        const longestLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
        const tw = fs * longestLine * 0.6;
        const th = lineH * lines.length;
        // Check overlap with slice source rect
        if (a.x + tw < s.x || a.x > s.x + s.w) return;
        if (a.y + th < s.y || a.y > s.y + s.h) return;
        // Convert to local slice coords, scaled
        const lx = (a.x - s.x) * sx;
        const ly = (a.y - s.y) * sy;
        const scaledFs = Math.round(fs * sx);
        const scaledLineH = Math.round(lineH * sy);
        ctx.font = `${a.bold ? 'bold ' : ''}${a.italic ? 'italic ' : ''}${scaledFs}px Arial, Helvetica, sans-serif`;
        // Background pill (covers all lines)
        if (a.bg && a.bg !== 'transparent') {
          const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
          const pad = Math.round(4 * sx);
          const totalH = scaledLineH * lines.length;
          ctx.fillStyle = a.bg;
          const bgRadius = Math.round(3 * sx);
          roundRect(ctx, lx - pad, ly - pad, maxW + pad * 2, totalH + pad * 2, bgRadius);
          ctx.fill();
        }
        // Draw each line
        ctx.fillStyle = a.color || '#ffffff';
        lines.forEach((line, i) => {
          ctx.fillText(line, lx, ly + i * scaledLineH);
        });
      });
      ctx.textBaseline = 'alphabetic'; // reset
    }
    return canvas;
  }

  // Rounded rectangle helper (for annotation background pills)
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Create a "display" copy of state with all coordinates scaled.
  // Used so buildHTMLDoc produces correctly-sized table cells and img tags
  // while the original state is still used for reading pixel data from the source image.
  // scaleState now supports independent X and Y scales (for custom height override).
  function scaleState(state, scale, scaleY) {
    const sy_ = scaleY || scale;
    if ((!scale || scale === 1) && (!sy_ || sy_ === 1)) return state;
    const imgW = Math.round(state.image.naturalWidth * scale);
    const imgH = Math.round(state.image.naturalHeight * sy_);
    return {
      ...state,
      image: { naturalWidth: imgW, naturalHeight: imgH },
      slices: state.slices.map(s => {
        // Scale x and right-edge independently, then derive w — avoids rounding gaps
        const sx = Math.round(s.x * scale);
        const syCoord = Math.round(s.y * sy_);
        const sr = Math.min(Math.round((s.x + s.w) * scale), imgW);
        const sb = Math.min(Math.round((s.y + s.h) * sy_), imgH);
        return { ...s, x: sx, y: syCoord, w: sr - sx, h: sb - syCoord };
      }),
    };
  }

  // Parse export options and compute derived values.
  // Supports both targetWidth (scales proportionally) and targetHeight (explicit height override).
  function resolveExportOpts(state, exportOpts) {
    exportOpts = exportOpts || {};
    const targetWidth = exportOpts.targetWidth;
    const targetHeight = exportOpts.targetHeight || null;
    const scaleX = (targetWidth && state.image)
      ? targetWidth / state.image.naturalWidth
      : 1;
    // Allow upscaling only if no targetWidth is set (original mode), otherwise clamp to 1
    const scale = targetWidth ? Math.min(1, scaleX) : 1;
    // Separate Y scale: if targetHeight is set explicitly, compute independent scaleY
    const scaleY = (targetHeight && state.image)
      ? targetHeight / state.image.naturalHeight
      : scale;  // default: proportional (same as X)
    const fmt = exportOpts.format || 'png';
    const mimeType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = fmt === 'jpeg' ? (exportOpts.quality || 0.92) : undefined;
    const ext = fmt === 'jpeg' ? '.jpg' : '.png';
    const outputType = exportOpts.outputType || 'html+images';
    const defaultLink = exportOpts.defaultLink || '';
    const bodyBgColor = exportOpts.bodyBgColor || '';
    return { scale, scaleY, fmt, mimeType, quality, ext, outputType, defaultLink, bodyBgColor };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), type, quality);
    });
  }

  // ---- Auto-grid: convert free-form user slices into a clean non-overlapping grid ----
  // Users can draw slices anywhere (overlapping, gaps, any order).
  // This function computes a pixel-perfect grid where:
  //   - Every pixel of the image is covered (no broken tables)
  //   - Clickable areas match the user's slices
  //   - Overlapping slices: topmost (last-drawn) wins
  //   - Gaps become non-clickable image cells
  function buildAutoGrid(slices, imgW, imgH) {
    if (!imgW || !imgH) return [];

    // Collect all unique X and Y cut lines (rounded to integers to match grid cells)
    const xSet = new Set([0, imgW]);
    const ySet = new Set([0, imgH]);
    slices.forEach(s => {
      xSet.add(Math.max(0, Math.min(imgW, Math.round(s.x))));
      xSet.add(Math.max(0, Math.min(imgW, Math.round(s.x + s.w))));
      ySet.add(Math.max(0, Math.min(imgH, Math.round(s.y))));
      ySet.add(Math.max(0, Math.min(imgH, Math.round(s.y + s.h))));
    });
    const xs = [...xSet].sort((a, b) => a - b);
    const ys = [...ySet].sort((a, b) => a - b);

    // Debug: log input slices and cut lines (only on first call per 500ms to avoid spam)
    const _dbgNow = Date.now();
    const _dbg = slices.some(s => s.href) && (!buildAutoGrid._lastLog || _dbgNow - buildAutoGrid._lastLog > 500);
    if (_dbg) {
      buildAutoGrid._lastLog = _dbgNow;
      console.log('[buildAutoGrid] Input slices:', slices.map(s =>
        `#${s.id} (${Math.round(s.x)},${Math.round(s.y)} ${Math.round(s.w)}x${Math.round(s.h)}) href="${s.href || ''}"`)
      );
      console.log('[buildAutoGrid] Cut lines X:', xs.join(','), ' Y:', ys.join(','));
    }

    // Build grid rows
    const gridRows = [];
    for (let yi = 0; yi < ys.length - 1; yi++) {
      const cellY = ys[yi];
      const cellH = ys[yi + 1] - cellY;
      if (cellH < 1) continue;
      const row = [];
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const cellX = xs[xi];
        const cellW = xs[xi + 1] - cellX;
        if (cellW < 1) continue;

        // Find the topmost (last-drawn) user slice that fully contains this cell
        let match = null;
        for (let i = slices.length - 1; i >= 0; i--) {
          const s = slices[i];
          const sl = Math.round(s.x), st = Math.round(s.y);
          const sr = Math.round(s.x + s.w), sb = Math.round(s.y + s.h);
          if (cellX >= sl && cellX + cellW <= sr + 1 &&
              cellY >= st && cellY + cellH <= sb + 1) {
            match = s;
            break;
          }
        }

        // Text slices with no actual text content should render as image
        // (cut from the original at that location). This prevents empty text
        // slices from leaving a white box on top of the design.
        const matchHasText = match && match.text && match.text.trim();
        const effectiveType = match
          ? (match.type === 'text' && !matchHasText ? 'image' : match.type)
          : 'image';
        row.push({
          id: match ? match.id : 0,
          x: Math.round(cellX), y: Math.round(cellY),
          w: Math.round(cellW), h: Math.round(cellH),
          href: match ? match.href : '',
          alt: match ? match.alt : '',
          type: effectiveType,
          text: match ? match.text : '',
          textStyle: match ? match.textStyle : null,
          color: match ? match.color : '#ccc',
          _isGap: !match,
          _srcSlice: match,
        });
      }
      // Horizontal merge WITH colspan tracking — merge adjacent cells from the same source,
      // but record how many master-grid columns each merged cell spans.
      // This keeps the table column grid consistent (via colspan) while avoiding text duplication.
      const merged = [];
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (merged.length > 0) {
          const prev = merged[merged.length - 1];
          if (prev._srcSlice === c._srcSlice && prev._isGap === c._isGap && prev.y === c.y && prev.h === c.h) {
            prev.w += c.w;
            prev._colspan = (prev._colspan || 1) + 1;
            continue;
          }
        }
        merged.push({ ...c, _colspan: 1 });
      }
      gridRows.push(merged);
    }

    // Merge vertically: if two consecutive rows have identical column structure, merge them
    const finalRows = [];
    for (let i = 0; i < gridRows.length; i++) {
      const row = gridRows[i];
      if (finalRows.length > 0) {
        const prevRow = finalRows[finalRows.length - 1];
        // Check if rows can merge (same structure: cell count, sources, widths, colspans)
        if (prevRow.length === row.length && prevRow.every((c, j) =>
          c._srcSlice === row[j]._srcSlice && c._isGap === row[j]._isGap &&
          c.x === row[j].x && c.w === row[j].w && (c._colspan || 1) === (row[j]._colspan || 1)
        )) {
          // Merge: extend each cell's height
          prevRow.forEach((c, j) => { c.h += row[j].h; });
          continue;
        }
      }
      finalRows.push(row.map(c => ({ ...c })));
    }

    // Debug: log final grid structure
    if (_dbg) {
      console.log('[buildAutoGrid] Final grid:');
      finalRows.forEach((row, ri) => {
        row.forEach(c => {
          const tag = c.href ? ` LINK="${c.href}"` : '';
          console.log(`  Row ${ri}: cell(${c.x},${c.y} ${c.w}x${c.h}) → slice #${c.id}${tag}${c._isGap ? ' [GAP]' : ''}`);
        });
      });
    }

    return finalRows;
  }

  // Legacy buildRows — kept for backward compatibility with computeRows in app.js
  function buildRows(slices) {
    if (slices.length === 0) return [];
    const sorted = [...slices].sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    const tolerance = 8;
    sorted.forEach(s => {
      const row = rows.find(r => {
        const top = Math.min(...r.map(x => x.y));
        const bot = Math.max(...r.map(x => x.y + x.h));
        return s.y < bot - tolerance && s.y + s.h > top + tolerance;
      });
      if (row) row.push(s);
      else rows.push([s]);
    });
    rows.forEach(r => r.sort((a, b) => a.x - b.x));
    return rows;
  }

  // Generate the slice <img> tag (with optional anchor).
  // overrideW allows clamping width when slices exceed table width.
  // All styles explicitly prevent dark-mode borders/outlines.
  let _imgCellId = 0;
  function imgCell(slice, src, overrideW, defaultLink) {
    const w = Math.round(overrideW || slice.w);
    const h = Math.round(overrideW ? slice.h * (overrideW / slice.w) : slice.h);
    const altText = slice.alt || `Slice ${slice.id}`;
    const owaId = `OWATemporaryImageDivContainer_${++_imgCellId}`;
    const img = `<img src="${escapeAttr(src)}" width="${w}" height="${h}" id="${owaId}" alt="${escapeAttr(altText)}" border="0" style="display:block;vertical-align:middle;border:0 none;outline:none;text-decoration:none;width:${w}px;height:${h}px;max-width:100%;line-height:0;font-size:0;-ms-interpolation-mode:bicubic;">`;
    const href = slice.href || defaultLink || '';
    const gmailAnchor = `<span style="color:transparent;font-size:0;line-height:0;display:none;mso-hide:all;">&nbsp;</span>`;
    if (href) {
      return `<a href="${escapeAttr(href)}" target="_blank" style="display:block;text-decoration:none;border:0 none;outline:none;font-size:0;line-height:0;cursor:pointer;">${img}${gmailAnchor}</a>`;
    }
    return img;
  }

  // Inline variant for multi-cell rows — uses inline-block so images sit side-by-side
  // in a single <td> without needing a nested table. More Gmail-paste-resilient.
  function imgCellInline(slice, src, overrideW, defaultLink) {
    const w = overrideW || slice.w;
    const h = overrideW ? Math.round(slice.h * (overrideW / slice.w)) : slice.h;
    const altText = slice.alt || `Slice ${slice.id}`;
    const img = `<img src="${escapeAttr(src)}" width="${w}" height="${h}" alt="${escapeAttr(altText)}" border="0" style="display:inline-block;vertical-align:middle;border:0 none;outline:none;text-decoration:none;width:${w}px;height:${h}px;max-width:${w}px;line-height:0;font-size:0;-ms-interpolation-mode:bicubic;">`;
    const href = slice.href || defaultLink || '';
    const gmailAnchor = `<span style="color:transparent;font-size:0;line-height:0;display:none;mso-hide:all;">&nbsp;</span>`;
    if (href) {
      return `<a href="${escapeAttr(href)}" target="_blank" style="display:inline-block;vertical-align:middle;text-decoration:none;border:0 none;outline:none;line-height:0;font-size:0;cursor:pointer;">${img}${gmailAnchor}</a>`;
    }
    return img;
  }

  // Render a text-block slice's content (used inside the parent <td>).
  function textCellContent(slice) {
    const ts = slice.textStyle || {};
    const styleParts = [
      `font-family:Arial,Helvetica,sans-serif`,
      `font-size:${ts.fontSize || 16}px`,
      `line-height:${Math.round((ts.fontSize || 16) * 1.45)}px`,
      `color:${ts.color || '#1f2329'}`,
      `text-align:${ts.align || 'left'}`,
      ts.bold ? 'font-weight:700' : 'font-weight:400',
      ts.italic ? 'font-style:italic' : '',
    ].filter(Boolean).join(';');
    const safe = escapeHtml(slice.text || '').replace(/\n/g, '<br/>');
    const inner = `<div style="${styleParts};padding:12px;">${safe}</div>`;
    if (slice.href) {
      return `<a href="${escapeAttr(slice.href)}" target="_blank" style="display:block;text-decoration:none;color:inherit;">${inner}</a>`;
    }
    return inner;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Transparent 1×1 GIF as data URI — universally supported, invisible in dark mode.
  // Using this instead of &nbsp; prevents dark-mode clients from highlighting text nodes.
  const SPACER_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Generate a spacer <td> with explicit width (transparent, dark-mode-safe).
  // Uses a stretched transparent GIF instead of &nbsp; to prevent dark-mode highlighting.
  function spacerCell(widthPx, heightPx) {
    return `<td width="${widthPx}" style="width:${widthPx}px;height:${heightPx}px;padding:0;border:0 none;font-size:0;line-height:0;mso-line-height-rule:exactly;"><img src="${SPACER_GIF}" width="${widthPx}" height="${heightPx}" alt="" border="0" style="display:block;border:0 none;outline:none;width:${widthPx}px;height:${heightPx}px;" /></td>`;
  }

  // Generate a spacer <tr> with explicit height for inter-row vertical gaps.
  function spacerRow(widthPx, heightPx) {
    return `<tr><td height="${heightPx}" colspan="99" style="width:${widthPx}px;height:${heightPx}px;padding:0;border:0 none;font-size:0;line-height:0;mso-line-height-rule:exactly;"><img src="${SPACER_GIF}" width="${widthPx}" height="${heightPx}" alt="" border="0" style="display:block;border:0 none;outline:none;width:${widthPx}px;height:${heightPx}px;" /></td></tr>`;
  }

  // Build the full HTML doc.
  // opts.imageSrc(slice) → returns the src string for that slice (data URL or relative path).
  // opts.client → 'gmail' | 'outlook' | 'apple' (changes preview chrome only)
  // opts.defaultLink → fallback URL for non-linked images (prevents email clients opening them as pictures)
  // opts.gridRows → pre-computed grid rows from buildAutoGrid (avoids recomputing and guarantees cellKey consistency)
  function buildHTMLDoc(state, opts) {
    const totalWidth = state.image ? state.image.naturalWidth : 600;
    const totalHeight = state.image ? state.image.naturalHeight : 800;
    const defLink = opts.defaultLink || '';
    const bgColor = opts.bodyBgColor || '';

    let tableRows = '';

    if (state.slices.length === 0 && state.image) {
      const fakeSlice = { id: 0, x: 0, y: 0, w: totalWidth, h: totalHeight, href: '', alt: 'Email' };
      tableRows = `<tr style="line-height:0;font-size:0;padding:0;margin:0;border:0 none;"><td valign="top" width="${totalWidth}" style="width:${totalWidth}px;padding:0;border:0 none;font-size:0;line-height:0;overflow:hidden;mso-line-height-rule:exactly;">${imgCell(fakeSlice, opts.imageSrc(fakeSlice), totalWidth, defLink)}</td></tr>`;
    } else {
      const gridRows = opts.gridRows || buildAutoGrid(state.slices, totalWidth, totalHeight);

      // Each grid row becomes one <tr> in the outer single-column table.
      // Single-cell rows use a direct <td> with display:block img.
      // Multi-cell rows pack inline-block images into one <td> — no nested
      // tables or colspan needed, so Gmail can't break the layout.
      gridRows.forEach(row => {
        const rowH = Math.round(row[0].h);
        const msoHeightFix = `line-height:${rowH}px;height:${rowH}px;`;
        if (row.length === 1) {
          const cell = row[0];
          if (cell.type === 'text' && !cell._isGap) {
            const ts = cell.textStyle || {};
            const hasBg = ts.bg && ts.bg !== 'transparent';
            const bgAttr = hasBg ? ` bgcolor="${ts.bg}"` : '';
            const bgStyle = hasBg ? `background-color:${ts.bg};` : '';
            tableRows += `<tr style="line-height:0;font-size:0;padding:0;margin:0;border:0 none;"><td align="left" valign="top" width="${totalWidth}"${bgAttr} style="width:${totalWidth}px;height:${cell.h}px;${bgStyle}padding:0;margin:0;border:0 none;overflow:hidden;mso-line-height-rule:exactly;${msoHeightFix}">${textCellContent(cell)}</td></tr>`;
          } else {
            tableRows += `<tr style="line-height:0;font-size:0;padding:0;margin:0;border:0 none;"><td align="left" valign="top" width="${totalWidth}" style="width:${totalWidth}px;padding:0;margin:0;border:0 none;font-size:0;line-height:0;overflow:hidden;mso-line-height-rule:exactly;${msoHeightFix}">${imgCell(cell, opts.imageSrc(cell), totalWidth, defLink)}</td></tr>`;
          }
        } else {
          const widths = row.map(c => Math.round(c.w));
          const sum = widths.reduce((a, b) => a + b, 0);
          if (sum !== totalWidth && widths.length > 0) {
            widths[widths.length - 1] += (totalWidth - sum);
          }
          let innerTds = '';
          row.forEach((cell, i) => {
            const w = widths[i];
            if (cell.type === 'text' && !cell._isGap) {
              const ts = cell.textStyle || {};
              const hasBg = ts.bg && ts.bg !== 'transparent';
              const bgAttr = hasBg ? ` bgcolor="${ts.bg}"` : '';
              const bgStyle = hasBg ? `background-color:${ts.bg};` : '';
              innerTds += `<td align="left" valign="top" width="${w}"${bgAttr} style="width:${w}px;height:${cell.h}px;${bgStyle}padding:0;margin:0;border:0 none;overflow:hidden;mso-line-height-rule:exactly;${msoHeightFix}">${textCellContent(cell)}</td>`;
            } else {
              innerTds += `<td align="left" valign="top" width="${w}" style="width:${w}px;padding:0;margin:0;border:0 none;font-size:0;line-height:0;overflow:hidden;mso-line-height-rule:exactly;${msoHeightFix}">${imgCell(cell, opts.imageSrc(cell), w, defLink)}</td>`;
            }
          });
          tableRows += `<tr style="line-height:0;font-size:0;padding:0;margin:0;border:0 none;"><td align="left" valign="top" width="${totalWidth}" style="width:${totalWidth}px;padding:0;margin:0;border:0 none;font-size:0;line-height:0;overflow:hidden;mso-line-height-rule:exactly;${msoHeightFix}">` +
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${totalWidth}" style="border-collapse:collapse;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;font-size:0;line-height:0;width:${totalWidth}px;table-layout:fixed;">` +
            `<tr style="line-height:0;font-size:0;padding:0;margin:0;border:0 none;">${innerTds}</tr></table></td></tr>`;
        }
      });
    }

    const previewChrome = opts.client ? clientChrome(opts.client) : { header: '', wrapStart: '', wrapEnd: '' };

    // Body background: only add outer wrapper table if a bgcolor is set.
    const hasBg = bgColor && bgColor !== 'transparent' && bgColor !== 'none';
    const bodyBgStyle = hasBg ? `background:${bgColor};` : '';
    const wrapOpen = hasBg
      ? `<table role="presentation" class="email-body" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bgColor}" style="margin:0;padding:0;border:0 none;border-collapse:collapse;border-spacing:0;background-color:${bgColor};width:100%;"><tr><td align="center" valign="top" bgcolor="${bgColor}" style="padding:0;border:0 none;background-color:${bgColor};">`
      : '<div class="email-body" style="margin:0;padding:0;">';
    const wrapClose = hasBg
      ? '</td></tr></table>'
      : '</div>';

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>EDM</title>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style type="text/css">
  :root { color-scheme: light only; }
  body { margin:0; padding:0; ${bodyBgStyle}-webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; border-spacing:0; mso-table-lspace:0pt; mso-table-rspace:0pt; font-size:0; line-height:0; }
  tr { line-height:0; font-size:0; padding:0; margin:0; border:0 none; }
  td { border:0 none; padding:0; font-size:0; line-height:0; }
  img { -ms-interpolation-mode:bicubic; display:block !important; vertical-align:middle !important; border:0 none; outline:none; text-decoration:none; line-height:0px !important; font-size:0px !important; }
  a { text-decoration:none; display:block; font-size:0; line-height:0; }
  .email-table { table-layout:fixed; }
  [data-ogsc] img, [data-ogsb] img { border:0 none !important; outline:none !important; }
  @media (prefers-color-scheme: dark) {
    ${hasBg ? `body, .email-body { background:${bgColor} !important; }` : ''}
    .email-table td { border:0 none !important; }
    .email-table img { border:0 none !important; outline:none !important; }
  }
  u + .body .email-table img { border:0 none !important; }
  ${previewChrome.css || ''}
</style>
</head>
<body class="body" style="margin:0;padding:0;${bodyBgStyle}">` +
`${previewChrome.wrapStart}` +
`${wrapOpen}` +
`<!--[if mso]><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="${totalWidth}"><tr><td><![endif]-->` +
`<div style="max-width:${totalWidth}px;width:${totalWidth}px;margin:0 auto;overflow:hidden;font-size:0;line-height:0;">` +
`<table role="presentation" class="email-table" align="center" cellpadding="0" cellspacing="0" border="0" width="${totalWidth}" style="border-collapse:collapse;border-spacing:0;margin:0 auto;border:0 none;table-layout:fixed;width:${totalWidth}px;max-width:${totalWidth}px;mso-table-lspace:0pt;mso-table-rspace:0pt;font-size:0;line-height:0;">` +
tableRows +
`</table>` +
`</div>` +
`<!--[if mso]></td></tr></table><![endif]-->` +
`${wrapClose}` +
`${previewChrome.wrapEnd}` +
`</body>` +
`</html>`;
  }

  // Lightweight per-client preview wrappers (cosmetic only — does NOT truly simulate rendering).
  function clientChrome(client) {
    if (client === 'gmail') {
      return {
        css: `.client-chrome{background:#f6f8fc;padding:24px 0;font-family:'Google Sans',Arial,sans-serif;} .client-chrome .bar{max-width:640px;margin:0 auto 12px;color:#5f6368;font-size:13px;padding:0 8px;}`,
        wrapStart: `<div class="client-chrome"><div class="bar">📧 Gmail preview — note: Gmail may clip emails over 102 KB and strip some CSS.</div>`,
        wrapEnd: `</div>`
      };
    }
    if (client === 'outlook') {
      return {
        css: `.client-chrome{background:#f3f2f1;padding:24px 0;font-family:'Segoe UI',Arial,sans-serif;} .client-chrome .bar{max-width:640px;margin:0 auto 12px;color:#605e5c;font-size:13px;padding:0 8px;}`,
        wrapStart: `<div class="client-chrome"><div class="bar">📧 Outlook preview — uses Word rendering engine. Watch for: spacing changes, dropped CSS backgrounds, font fallbacks.</div>`,
        wrapEnd: `</div>`
      };
    }
    if (client === 'apple') {
      return {
        css: `.client-chrome{background:#fafafa;padding:24px 0;font-family:-apple-system,Helvetica,Arial,sans-serif;} .client-chrome .bar{max-width:640px;margin:0 auto 12px;color:#666;font-size:13px;padding:0 8px;}`,
        wrapStart: `<div class="client-chrome"><div class="bar">📧 Apple Mail preview — best CSS support of the three. If it looks right here, it usually does on iPhone too.</div>`,
        wrapEnd: `</div>`
      };
    }
    return { css: '', wrapStart: '', wrapEnd: '' };
  }

  // Preview: generate data-URL images for each slice.
  // For preview, scale down large slices to prevent canvas memory exhaustion
  // (very large canvases cause toDataURL to return "data:," silently).
  // opts.exportOpts can carry {targetWidth} to show the email at export width.
  function buildHTML(state, opts) {
    if (!state.image) return '<p>No image loaded.</p>';

    // Compute the display scale from export settings (so preview shows at export width)
    const eo = resolveExportOpts(state, opts.exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const sy = eo.scaleY || eo.scale;

    // Build the auto-grid from the SCALED state — this is the same grid buildHTMLDoc will use,
    // so data URL keys will match the cell coordinates in the final HTML.
    const scaledW = scaledState.image ? scaledState.image.naturalWidth : 600;
    const scaledH = scaledState.image ? scaledState.image.naturalHeight : 800;
    const gridRows = scaledState.slices.length
      ? buildAutoGrid(scaledState.slices, scaledW, scaledH)
      : [[{ id: 0, x: 0, y: 0, w: scaledW, h: scaledH, href: '', alt: 'Email', type: 'image', _isGap: false }]];

    // Generate a data URL for every grid cell that needs an image.
    // Key by scaled "x,y,w,h" since that matches what buildHTMLDoc will look up.
    const dataURLs = {};
    const MAX_DIM = 800;
    const previewMime = eo.fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
    const previewQ = eo.fmt === 'jpeg' ? (eo.quality || 0.85) : undefined;

    for (const row of gridRows) {
      for (const cell of row) {
        if (cell.type === 'text' && !cell._isGap) continue;
        const key = cellKey(cell);
        if (dataURLs[key]) continue;
        try {
          // Output size = scaled cell size (clamped for memory safety)
          let cw = cell.w, ch = cell.h;
          if (cw > MAX_DIM || ch > MAX_DIM) {
            const memScale = Math.min(MAX_DIM / cw, MAX_DIM / ch);
            cw = Math.round(cw * memScale);
            ch = Math.round(ch * memScale);
          }
          // Reverse-scale to get original image coordinates for canvas cutting
          const origCell = {
            x: cell.x / eo.scale, y: cell.y / sy,
            w: cell.w / eo.scale, h: cell.h / sy,
          };
          const c = sliceToCanvas(state.image, origCell, cw, ch, state.annotations, getCellThumb(cell));
          const dataUrl = c.toDataURL(previewMime, previewQ);
          dataURLs[key] = (dataUrl && dataUrl.length > 50) ? dataUrl : '';
        } catch (err) {
          console.warn(`Cell (${key}): preview image failed`, err);
          dataURLs[key] = '';
        }
      }
    }
    releaseSliceCanvas();

    return buildHTMLDoc(scaledState, {
      client: opts.client,
      defaultLink: eo.defaultLink,
      bodyBgColor: eo.bodyBgColor,
      imageSrc: s => dataURLs[cellKey(s)] || '',
      gridRows: gridRows,
    });
  }

  // Helper: collect unique image grid cells from the SCALED state.
  // Each cell has scaled x/y/w/h (matching what buildHTMLDoc will produce)
  // plus _origX/_origY/_origW/_origH for cutting from the source image.
  function collectGridCells(state, scaledState, eo) {
    const sy = eo.scaleY || eo.scale;
    const scaledW = scaledState.image ? scaledState.image.naturalWidth : 600;
    const scaledH = scaledState.image ? scaledState.image.naturalHeight : 800;
    if (!scaledState.slices.length) {
      return { cells: [{
        id: 0, x: 0, y: 0, w: scaledW, h: scaledH,
        _origX: 0, _origY: 0, _origW: state.image.naturalWidth, _origH: state.image.naturalHeight,
        href: '', alt: 'Email', type: 'image', _isGap: false
      }], gridRows: null };
    }
    const gridRows = buildAutoGrid(scaledState.slices, scaledW, scaledH);
    const cells = [];
    const seen = new Set();
    for (const row of gridRows) {
      for (const cell of row) {
        if (cell.type === 'text' && !cell._isGap) continue;
        const key = cellKey(cell);
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push({
          ...cell,
          _origX: cell.x / eo.scale, _origY: cell.y / sy,
          _origW: cell.w / eo.scale, _origH: cell.h / sy,
        });
      }
    }
    return { cells, gridRows };
  }
  function cellKey(s) { return `${s.x},${s.y},${s.w},${s.h}`; }

  // EXPORT: builds the ZIP with /images/ folder and clean index.html (no embedded base64).
  async function exportZip(state, exportOpts) {
    if (!window.JSZip) throw new Error('JSZip not loaded');
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const base = state.imageName || 'edm';

    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const filenames = {};
    let idx = 0;

    if (eo.outputType !== 'html') {
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const thumb = getCellThumb(s);
          const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, thumb);
          const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
          const fname = `slice_${String(++idx).padStart(2, '0')}${eo.ext}`;
          filenames[cellKey(s)] = fname;
          imgFolder.file(fname, blob);
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): zip image failed`, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      releaseSliceCanvas();
    }

    if (eo.outputType !== 'images') {
      const html = buildHTMLDoc(scaledState, {
        client: null,
        defaultLink: eo.defaultLink,
        bodyBgColor: eo.bodyBgColor,
        imageSrc: s => filenames[cellKey(s)] ? `images/${filenames[cellKey(s)]}` : '',
        gridRows: _gridRows,
      });
      zip.file('index.html', html);
      zip.file('README.txt', deploymentReadme(state, eo.ext));
    }

    const out = await zip.generateAsync({ type: 'blob' });
    triggerDownload(out, `${base}_edm.zip`);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 30000);
  }

  function deploymentReadme(state, ext) {
    ext = ext || '.png';
    return [
      'EDM EXPORT — DEPLOYMENT NOTES',
      '================================',
      '',
      'CONTENTS',
      '  index.html        - the email HTML (Outlook-safe nested-table layout)',
      `  images/           - sliced ${ext === '.jpg' ? 'JPEGs' : 'PNGs'} referenced by index.html`,
      '',
      'BEFORE SENDING',
      '  1. Upload the images/ folder to a public CDN or web host (S3, CloudFront,',
      '     Cloudflare R2, or your existing hosting). Note the public base URL.',
      '  2. Open index.html and replace every "images/" path with your CDN URL.',
      `     e.g.  src="images/slice_01${ext}"  ->  src="https://cdn.example.com/edm123/slice_01${ext}"`,
      '  3. Email clients DO NOT load images from your local computer. Without a CDN',
      '     the images will appear as broken icons for the recipients.',
      '',
      'SENDING THROUGH PLATFORMS',
      '  - Mailchimp:  Create campaign > Code your own > Paste in HTML > Save',
      '  - Outlook:    File > Save As .oft, OR paste HTML into a new message',
      '  - AWS SES:    Use the HTML body via SES SendEmail API',
      '  - Gmail:      Gmail does not support pasting HTML directly. Use Mailchimp,',
      '                SendGrid, or a similar sender to inject the HTML.',
      '',
      'TESTING',
      '  Send a test to one Gmail, one Outlook Desktop, and one mobile inbox before',
      '  rolling out. Outlook is the most likely client to break the layout.',
      '',
      `Slices: ${state.slices.length} | Image: ${state.image ? state.image.naturalWidth + 'x' + state.image.naturalHeight : 'n/a'}`,
    ].join('\r\n');
  }

  // ========================================================================
  // EML EXPORT — self-contained .eml file with CID-embedded images.
  // ========================================================================
  //
  // Produces a multipart/related message:
  //   multipart/related
  //   ├── text/html  (HTML uses src="cid:slice_NN")
  //   ├── image/png Content-ID: <slice_01>
  //   ├── image/png Content-ID: <slice_02>
  //   └── ...
  //
  // Open the .eml in Outlook / Apple Mail to view, or attach it to a forward.

  // CRLF is required by RFC 5322. \n alone breaks Outlook.
  const CRLF = '\r\n';

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => {
        const s = r.result;
        // strip "data:image/jpeg;base64," prefix
        resolve(s.substring(s.indexOf(',') + 1));
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // Wrap base64 to 76 chars per line per RFC 2045.
  function wrap76(s) {
    if (!s) return '';
    const lines = s.match(/.{1,76}/g);
    return lines ? lines.join(CRLF) : '';
  }

  // RFC 2047 encoded-word for non-ASCII subject lines.
  function encodeHeader(s) {
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    const b64 = btoa(unescape(encodeURIComponent(s)));
    return `=?UTF-8?B?${b64}?=`;
  }

  function rfc2822Date(d) {
    return d.toUTCString().replace('GMT', '+0000');
  }

  async function exportEml(state, opts, exportOpts) {
    if (!state.image) throw new Error('No image loaded');
    opts = opts || {};
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const from    = opts.from    || 'sender@example.com';
    const to      = opts.to      || 'recipient@example.com';
    const subject = opts.subject || (state.imageName || 'EDM') + ' campaign';
    const base    = state.imageName || 'edm';

    // Generate grid-cell images + CID map.
    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const cidMap = {};   // cellKey -> cid string
    const imgParts = []; // each: { cid, filename, base64, mimeType }
    let idx = 0;

    for (const s of cells) {
      try {
        const outW = Math.round(s.w);
        const outH = Math.round(s.h);
        const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
        const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
        const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
        const b64 = await blobToBase64(blob);
        const cid = `slice_${String(++idx).padStart(2, '0')}.${base}@edmtool.local`;
        const fname = `slice_${String(idx).padStart(2, '0')}${eo.ext}`;
        cidMap[cellKey(s)] = cid;
        imgParts.push({ cid, filename: fname, base64: b64, mimeType: eo.mimeType });
      } catch (err) {
        console.warn(`Cell (${cellKey(s)}): EML image failed`, err);
      }
      await new Promise(r => setTimeout(r, 0));
    }
    releaseSliceCanvas();

    // Build HTML with cid: references — use same grid that produced the image cells.
    const html = buildHTMLDoc(scaledState, {
      client: null,
      defaultLink: eo.defaultLink,
      bodyBgColor: eo.bodyBgColor,
      gridRows: _gridRows,
      imageSrc: s => `cid:${cidMap[cellKey(s)]}`,
    });

    // Plain-text fallback.
    const textPart = buildPlainText(state);

    // Assemble MIME.
    const boundaryRelated = 'related_' + randomBoundary();
    const boundaryAlt     = 'alt_' + randomBoundary();

    let mime = '';
    mime += `From: ${from}${CRLF}`;
    mime += `To: ${to}${CRLF}`;
    mime += `Subject: ${encodeHeader(subject)}${CRLF}`;
    mime += `Date: ${rfc2822Date(new Date())}${CRLF}`;
    mime += `MIME-Version: 1.0${CRLF}`;
    mime += `Content-Type: multipart/related; boundary="${boundaryRelated}"; type="multipart/alternative"${CRLF}`;
    mime += CRLF;
    mime += `This is a multipart MIME message. Your client should render it inline.${CRLF}`;
    mime += CRLF;

    // multipart/alternative (text + HTML)
    mime += `--${boundaryRelated}${CRLF}`;
    mime += `Content-Type: multipart/alternative; boundary="${boundaryAlt}"${CRLF}`;
    mime += CRLF;

    mime += `--${boundaryAlt}${CRLF}`;
    mime += `Content-Type: text/plain; charset="UTF-8"${CRLF}`;
    mime += `Content-Transfer-Encoding: 7bit${CRLF}`;
    mime += CRLF;
    mime += textPart + CRLF;
    mime += CRLF;

    mime += `--${boundaryAlt}${CRLF}`;
    mime += `Content-Type: text/html; charset="UTF-8"${CRLF}`;
    mime += `Content-Transfer-Encoding: 7bit${CRLF}`;
    mime += CRLF;
    mime += html + CRLF;
    mime += CRLF;

    mime += `--${boundaryAlt}--${CRLF}`;
    mime += CRLF;

    // image parts
    for (const p of imgParts) {
      mime += `--${boundaryRelated}${CRLF}`;
      mime += `Content-Type: ${p.mimeType || 'image/png'}; name="${p.filename}"${CRLF}`;
      mime += `Content-Transfer-Encoding: base64${CRLF}`;
      mime += `Content-ID: <${p.cid}>${CRLF}`;
      mime += `Content-Disposition: inline; filename="${p.filename}"${CRLF}`;
      mime += CRLF;
      mime += wrap76(p.base64) + CRLF;
      mime += CRLF;
    }

    mime += `--${boundaryRelated}--${CRLF}`;

    const blob = new Blob([mime], { type: 'message/rfc822' });
    triggerDownload(blob, `${base}.eml`);
  }

  function randomBoundary() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function buildPlainText(state) {
    const lines = [
      'This email contains an HTML version with images. If you are reading this,',
      'your mail client does not support HTML rendering.',
      '',
      `Slices in this EDM: ${state.slices.length}`,
    ];
    state.slices.forEach(s => {
      if (s.href) lines.push(`  - Slice #${s.id}: ${s.href}`);
    });
    return lines.join(CRLF);
  }

  // ========================================================================
  // PLATFORM-TUNED EXPORTS
  // Each one adapts the HTML + packaging for one specific sending platform.
  // ========================================================================

  // Mailchimp: HTML with merge tags ({{UnsubscribeURL}}, {{ViewInBrowser}}),
  // plus images.zip you upload to Mailchimp Content Studio.
  async function exportMailchimp(state, exportOpts) {
    if (!window.JSZip) throw new Error('JSZip not loaded');
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const base = state.imageName || 'edm';

    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const filenames = {};
    let mcIdx = 0;
    if (eo.outputType !== 'html') {
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
          const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
          const fname = `slice_${String(++mcIdx).padStart(2, '0')}${eo.ext}`;
          filenames[cellKey(s)] = fname;
          imgFolder.file(fname, blob);
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): Mailchimp image failed`, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      releaseSliceCanvas();
    }

    if (eo.outputType !== 'images') {
      // HTML with placeholder *|MC:IMAGE|* style URLs the user replaces after upload
      const mcWidth = scaledState.image ? scaledState.image.naturalWidth : 640;
      let html = buildHTMLDoc(scaledState, { client: null, defaultLink: eo.defaultLink, bodyBgColor: eo.bodyBgColor, gridRows: _gridRows, imageSrc: s => filenames[cellKey(s)] ? `images/${filenames[cellKey(s)]}` : '' });

      // Inject Mailchimp footer if not already present
      if (!/UnsubscribeURL|unsub/i.test(html)) {
        html = html.replace('</body>', mailchimpFooter(mcWidth) + '</body>');
      }

      zip.file('index.html', html);
      zip.file('README.txt', mailchimpReadme());
    }
    const out = await zip.generateAsync({ type: 'blob' });
    triggerDownload(out, `${base}_mailchimp.zip`);
  }

  function mailchimpFooter(width) {
    width = width || 640;
    return `
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="${width}" style="margin:0 auto;">
  <tr><td style="padding:20px 40px;background:#1f2329;font-family:Arial,Helvetica,sans-serif;color:#9ca3af;font-size:11px;line-height:18px;text-align:center;">
    You are receiving this email as a subscriber to Communique communications.<br/>
    <a href="*|UNSUB|*" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a> &middot;
    <a href="*|ARCHIVE|*" style="color:#9ca3af;text-decoration:underline;">View in browser</a> &middot;
    <a href="*|UPDATE_PROFILE|*" style="color:#9ca3af;text-decoration:underline;">Update preferences</a>
    <br/><br/>*|HTML:LIST_ADDRESS_HTML|*
  </td></tr>
</table>`;
  }

  function mailchimpReadme() {
    return [
      'MAILCHIMP EXPORT',
      '================',
      '',
      'STEP 1 — Upload images',
      '  Mailchimp Dashboard > Content > Content Studio',
      '  Drag the /images folder in. Note the base URL Mailchimp gives you.',
      '',
      'STEP 2 — Patch the HTML paths',
      '  Open index.html in a text editor.',
      '  Find: src="images/',
      '  Replace with: src="https://mcusercontent.com/<your-account>/images/edm/',
      '',
      'STEP 3 — Create the campaign',
      '  Campaigns > Create > Email > Regular',
      '  Design: "Code your own" > "Paste in code"',
      '  Paste the entire contents of index.html. Save.',
      '',
      'STEP 4 — Send',
      '  Pick your audience. Send test to yourself first.',
      '  When happy, Send Now.',
      '',
      'NOTE: Merge tags *|UNSUB|*, *|ARCHIVE|*, *|UPDATE_PROFILE|* are auto-replaced',
      'by Mailchimp at send time. Do not edit them.',
    ].join('\r\n');
  }

  // Gmail: HTML embedded with base64 data-URL images (so paste-into-compose just works
  // without any CDN). We copy to clipboard.
  //
  // IMPORTANT: navigator.clipboard.write() requires a user-gesture context.
  // The setTimeout(0) yields used in other exporters to keep the UI responsive
  // would break the gesture chain here, so we generate images synchronously
  // and call clipboard.write ASAP. For the ClipboardItem constructor, we pass
  // a Promise<Blob> so the write() call happens in the gesture frame while
  // image generation can still run.
  // Normalize options for Gmail: force 600px width, drop defaultLink and bodyBgColor
  // so non-linked slices stay non-linked (Gmail will pop them up as photo on click)
  // and no extra background bleeds beyond the email content.
  function gmailifyOpts(state, exportOpts) {
    const opts = { ...(exportOpts || {}) };
    const imgW = state.image ? state.image.naturalWidth : 600;
    if (!opts.targetWidth || opts.targetWidth > 600) {
      opts.targetWidth = imgW > 600 ? 600 : imgW;
    }
    opts.defaultLink = '';
    opts.bodyBgColor = '';
    return opts;
  }

  async function exportGmailClipboard(state, exportOpts) {
    const eo = resolveExportOpts(state, gmailifyOpts(state, exportOpts));
    const scaledState = scaleState(state, eo.scale, eo.scaleY);

    function generateHtml() {
      const dataURLs = {};
      const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const c = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
          const dataUrl = c.toDataURL(eo.mimeType, eo.quality);
          dataURLs[cellKey(s)] = (dataUrl && dataUrl.length > 50) ? dataUrl : '';
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): image failed`, err);
          dataURLs[cellKey(s)] = '';
        }
      }
      releaseSliceCanvas();
      return buildHTMLDoc(scaledState, { client: null, defaultLink: eo.defaultLink, bodyBgColor: eo.bodyBgColor, gridRows: _gridRows, imageSrc: s => dataURLs[cellKey(s)] || '' });
    }

    // Strategy 1: Render in hidden container and copy the rendered DOM.
    // Gmail strips data: URLs from raw HTML clipboard, but rendered-DOM copy
    // goes through Chrome's selection serializer which can preserve images.
    try {
      const html = generateHtml();
      const emailWidth = scaledState.image ? scaledState.image.naturalWidth : 600;
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:0;top:0;width:' + emailWidth + 'px;z-index:-9999;opacity:0.01;pointer-events:none;overflow:hidden;';
      // Extract just the body content — avoids injecting <style> blocks into the page
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      container.innerHTML = bodyMatch ? bodyMatch[1] : html;
      document.body.appendChild(container);

      const imgs = container.querySelectorAll('img');
      if (imgs.length > 0) {
        await Promise.all([...imgs].map(img =>
          img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })
        ));
      }

      const range = document.createRange();
      range.selectNodeContents(container);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(container);
      return { ok: true, mode: 'rich' };
    } catch (err1) {
      console.warn('Gmail rendered-copy failed:', err1);
    }

    // Strategy 2: ClipboardItem with deferred blob promise (preserves gesture chain)
    try {
      const htmlPromise = Promise.resolve().then(() => generateHtml());
      const item = new ClipboardItem({
        'text/html': htmlPromise.then(h => new Blob([h], { type: 'text/html' })),
        'text/plain': htmlPromise.then(h => new Blob([h], { type: 'text/plain' })),
      });
      await navigator.clipboard.write([item]);
      return { ok: true, mode: 'rich' };
    } catch (err) {
      // Strategy 3: generate synchronously, write immediately
      try {
        const html = generateHtml();
        const blobHtml = new Blob([html], { type: 'text/html' });
        const blobText = new Blob([html], { type: 'text/plain' });
        const item = new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobText });
        await navigator.clipboard.write([item]);
        return { ok: true, mode: 'rich' };
      } catch (err2) {
        // Strategy 4: plain text clipboard
        try {
          const html = generateHtml();
          await navigator.clipboard.writeText(html);
          return { ok: true, mode: 'plain' };
        } catch (err3) {
          // Strategy 5: execCommand fallback
          try {
            const html = generateHtml();
            const ta = document.createElement('textarea');
            ta.value = html;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return { ok: true, mode: 'plain' };
          } catch (err4) {
            // Final fallback: download HTML file
            const html = generateHtml();
            const blob = new Blob([html], { type: 'text/html' });
            triggerDownload(blob, (state.imageName || 'edm') + '_gmail.html');
            return { ok: false, mode: 'download' };
          }
        }
      }
    }
  }

  // AWS SES: HTML file + a SendEmail API JSON request body the user can plug into
  // the AWS CLI or SDK.
  async function exportSES(state, opts, exportOpts) {
    if (!window.JSZip) throw new Error('JSZip not loaded');
    opts = opts || {};
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const from    = opts.from    || 'no-reply@yourdomain.com';
    const to      = opts.to      || 'recipient@example.com';
    const subject = opts.subject || (state.imageName || 'EDM') + ' campaign';

    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const base = state.imageName || 'edm';

    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const filenames = {};
    let sesIdx = 0;
    if (eo.outputType !== 'html') {
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
          const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
          const fname = `slice_${String(++sesIdx).padStart(2, '0')}${eo.ext}`;
          filenames[cellKey(s)] = fname;
          imgFolder.file(fname, blob);
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): SES image failed`, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      releaseSliceCanvas();
    }

    if (eo.outputType !== 'images') {
      const html = buildHTMLDoc(scaledState, { client: null, defaultLink: eo.defaultLink, bodyBgColor: eo.bodyBgColor, gridRows: _gridRows, imageSrc: s => filenames[cellKey(s)] ? `https://your-cdn.example.com/${base}/${filenames[cellKey(s)]}` : '' });
      zip.file('index.html', html);

      const sesRequest = {
        Source: from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      };
      zip.file('ses-request.json', JSON.stringify(sesRequest, null, 2));

      const cliCmd = `aws ses send-email --cli-input-json file://ses-request.json --region ap-south-1`;
      zip.file('send.sh', `#!/usr/bin/env bash\n# Upload images to your CDN first, then patch index.html URLs.\n${cliCmd}\n`);
      zip.file('README.txt', sesReadme());
    }

    const out = await zip.generateAsync({ type: 'blob' });
    triggerDownload(out, `${base}_ses.zip`);
  }

  function sesReadme() {
    return [
      'AWS SES EXPORT',
      '==============',
      '',
      'STEP 1 — Upload images to your CDN (S3 + CloudFront recommended)',
      '  aws s3 cp images/ s3://your-bucket/edm/ --recursive --acl public-read',
      '',
      'STEP 2 — Patch index.html',
      '  Replace https://your-cdn.example.com/ with your actual public base URL.',
      '',
      'STEP 3 — Verify the From address in SES',
      '  aws ses verify-email-identity --email-address sender@yourdomain.com',
      '',
      'STEP 4 — Send',
      '  bash send.sh',
      '  Or use the SES SDK in any language and pass the JSON body in ses-request.json.',
      '',
      'NOTE: SES sandbox accounts can only send to verified addresses. Request',
      'production access in the SES console before real campaigns.',
    ].join('\r\n');
  }

  // Raw HTML: just the .html file, no zip, no images. Useful for previewing or
  // pasting into custom systems.
  async function exportRawHtml(state, exportOpts) {
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const dataURLs = {};
    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);

    if (eo.outputType === 'images') {
      // Images-only mode: download a zip of sliced images, no HTML
      if (!window.JSZip) throw new Error('JSZip not loaded');
      const zip = new JSZip();
      let rawIdx = 0;
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const c = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
          const blob = await canvasToBlob(c, eo.mimeType, eo.quality);
          zip.file(`slice_${String(++rawIdx).padStart(2, '0')}${eo.ext}`, blob);
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): image export failed`, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      releaseSliceCanvas();
      const out = await zip.generateAsync({ type: 'blob' });
      triggerDownload(out, (state.imageName || 'edm') + '_images.zip');
      return;
    }

    if (eo.outputType !== 'html') {
      // Normal mode: embed images as base64 data URLs
      for (const s of cells) {
        try {
          const outW = Math.round(s.w);
          const outH = Math.round(s.h);
          const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
          const c = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
          const dataUrl = c.toDataURL(eo.mimeType, eo.quality);
          dataURLs[cellKey(s)] = (dataUrl && dataUrl.length > 50) ? dataUrl : '';
        } catch (err) {
          console.warn(`Cell (${cellKey(s)}): image export failed`, err);
          dataURLs[cellKey(s)] = '';
        }
        await new Promise(r => setTimeout(r, 0));
      }
      releaseSliceCanvas();
    }

    const html = buildHTMLDoc(scaledState, { client: null, defaultLink: eo.defaultLink, bodyBgColor: eo.bodyBgColor, gridRows: _gridRows, imageSrc: s => dataURLs[cellKey(s)] || '' });
    const blob = new Blob([html], { type: 'text/html' });
    triggerDownload(blob, (state.imageName || 'edm') + '.html');
    return html;
  }

  // OFT (Outlook File Template): We generate the same .eml (since .oft is a
  // proprietary binary format that can't be created in JavaScript). The
  // after-export guide instructs the user to save-as .oft inside Outlook.
  // We name the file _template.eml so it's clear this is meant to become an .oft.
  async function exportOft(state, opts, exportOpts) {
    if (!state.image) throw new Error('No image loaded');
    opts = opts || {};
    const eo = resolveExportOpts(state, exportOpts);
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const from    = opts.from    || 'sender@example.com';
    const to      = opts.to      || 'recipient@example.com';
    const subject = opts.subject || (state.imageName || 'EDM') + ' campaign';
    const base    = state.imageName || 'edm';

    // Generate grid-cell images + CID map (same as exportEml).
    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const cidMap = {};
    const imgParts = [];
    let oftIdx = 0;

    for (const s of cells) {
      try {
        const outW = Math.round(s.w);
        const outH = Math.round(s.h);
        const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
        const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
        const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
        const b64 = await blobToBase64(blob);
        const cid = `slice_${String(++oftIdx).padStart(2, '0')}.${base}@edmtool.local`;
        const fname = `slice_${String(oftIdx).padStart(2, '0')}${eo.ext}`;
        cidMap[cellKey(s)] = cid;
        imgParts.push({ cid, filename: fname, base64: b64, mimeType: eo.mimeType });
      } catch (err) {
        console.warn(`Cell (${cellKey(s)}): OFT image failed`, err);
      }
      await new Promise(r => setTimeout(r, 0));
    }
    releaseSliceCanvas();

    const html = buildHTMLDoc(scaledState, {
      client: null,
      defaultLink: eo.defaultLink,
      bodyBgColor: eo.bodyBgColor,
      gridRows: _gridRows,
      imageSrc: s => `cid:${cidMap[cellKey(s)]}`,
    });
    const textPart = buildPlainText(state);

    const boundaryRelated = 'related_' + randomBoundary();
    const boundaryAlt     = 'alt_' + randomBoundary();

    let mime = '';
    mime += `From: ${from}${CRLF}`;
    mime += `To: ${to}${CRLF}`;
    mime += `Subject: ${encodeHeader(subject)}${CRLF}`;
    mime += `Date: ${rfc2822Date(new Date())}${CRLF}`;
    mime += `MIME-Version: 1.0${CRLF}`;
    mime += `Content-Type: multipart/related; boundary="${boundaryRelated}"; type="multipart/alternative"${CRLF}`;
    mime += CRLF;
    mime += `This is a multipart MIME message. Your client should render it inline.${CRLF}`;
    mime += CRLF;

    mime += `--${boundaryRelated}${CRLF}`;
    mime += `Content-Type: multipart/alternative; boundary="${boundaryAlt}"${CRLF}`;
    mime += CRLF;

    mime += `--${boundaryAlt}${CRLF}`;
    mime += `Content-Type: text/plain; charset="UTF-8"${CRLF}`;
    mime += `Content-Transfer-Encoding: 7bit${CRLF}`;
    mime += CRLF;
    mime += textPart + CRLF;
    mime += CRLF;

    mime += `--${boundaryAlt}${CRLF}`;
    mime += `Content-Type: text/html; charset="UTF-8"${CRLF}`;
    mime += `Content-Transfer-Encoding: 7bit${CRLF}`;
    mime += CRLF;
    mime += html + CRLF;
    mime += CRLF;

    mime += `--${boundaryAlt}--${CRLF}`;
    mime += CRLF;

    for (const p of imgParts) {
      mime += `--${boundaryRelated}${CRLF}`;
      mime += `Content-Type: ${p.mimeType || 'image/png'}; name="${p.filename}"${CRLF}`;
      mime += `Content-Transfer-Encoding: base64${CRLF}`;
      mime += `Content-ID: <${p.cid}>${CRLF}`;
      mime += `Content-Disposition: inline; filename="${p.filename}"${CRLF}`;
      mime += CRLF;
      mime += wrap76(p.base64) + CRLF;
      mime += CRLF;
    }

    mime += `--${boundaryRelated}--${CRLF}`;

    // Download with _template suffix so user knows this is for .oft conversion
    const blob = new Blob([mime], { type: 'message/rfc822' });
    triggerDownload(blob, `${base}_template.eml`);
  }

  // Download as .html with embedded base64 images, Gmail-tuned (600px, no defaultLink, no body bg).
  async function exportGmailHtml(state, exportOpts) {
    const eo = resolveExportOpts(state, gmailifyOpts(state, exportOpts));
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const dataURLs = {};
    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    for (const s of cells) {
      try {
        const outW = Math.round(s.w);
        const outH = Math.round(s.h);
        const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
        const c = sliceToCanvas(state.image, origCell, outW, outH, state.annotations, getCellThumb(s));
        const dataUrl = c.toDataURL(eo.mimeType, eo.quality);
        dataURLs[cellKey(s)] = (dataUrl && dataUrl.length > 50) ? dataUrl : '';
      } catch (err) {
        console.warn(`Cell (${cellKey(s)}): gmail html image failed`, err);
        dataURLs[cellKey(s)] = '';
      }
      await new Promise(r => setTimeout(r, 0));
    }
    releaseSliceCanvas();
    const html = buildHTMLDoc(scaledState, {
      client: null,
      defaultLink: eo.defaultLink,
      bodyBgColor: eo.bodyBgColor,
      gridRows: _gridRows,
      imageSrc: s => dataURLs[cellKey(s)] || '',
    });
    const blob = new Blob([html], { type: 'text/html' });
    triggerDownload(blob, (state.imageName || 'edm') + '_gmail.html');
  }

  async function exportGmailImage(state, exportOpts) {
    const eo = resolveExportOpts(state, exportOpts);
    if (!state.image) throw new Error('No image loaded');
    const scale = eo.scale || 1;
    const sy = eo.scaleY || scale;
    const outW = Math.round(state.image.naturalWidth * scale);
    const outH = Math.round(state.image.naturalHeight * sy);
    const origCell = { x: 0, y: 0, w: state.image.naturalWidth, h: state.image.naturalHeight };
    const canvas = sliceToCanvas(state.image, origCell, outW, outH, state.annotations);
    const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
    releaseSliceCanvas();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob })
    ]);
  }

  // ---- Cloudinary CDN upload ----
  async function uploadToCloudinary(blob, cloudName, uploadPreset, filename) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('upload_preset', uploadPreset);
    fd.append('folder', 'edm');
    const resp = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, {
      method: 'POST',
      body: fd,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Cloudinary upload failed (${resp.status}): ${errText}`);
    }
    return resp.json();
  }

  async function testCloudinary(cloudName, uploadPreset) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const blob = await canvasToBlob(c, 'image/png');
    const result = await uploadToCloudinary(blob, cloudName, uploadPreset, 'test.png');
    return result.secure_url;
  }

  // --- Dual CDN export: Gmail (table-sliced) + Outlook/Apple (image map) ---

  async function exportCloudinary(state, exportOpts, cloudName, uploadPreset, onProgress) {
    if (!cloudName || !uploadPreset) throw new Error('Cloudinary cloud name and upload preset are required.');
    if (!state.image) throw new Error('No image loaded.');
    const eo = resolveExportOpts(state, exportOpts);
    const base = (state.imageName || 'edm').replace(/[^a-zA-Z0-9_-]/g, '_');
    const scaledState = scaleState(state, eo.scale, eo.scaleY);
    const natW = state.image.naturalWidth;
    const natH = state.image.naturalHeight;
    const outW = Math.round(natW * eo.scale);
    const outH = Math.round(natH * eo.scaleY);

    // Phase 1: Upload sliced grid cells for Gmail version
    const { cells, gridRows: _gridRows } = collectGridCells(state, scaledState, eo);
    const cdnUrls = {};
    const totalSteps = cells.length + 1; // +1 for the full image
    let step = 0;

    for (const s of cells) {
      step++;
      if (onProgress) onProgress(step, totalSteps, 'Gmail');
      const outCW = Math.round(s.w);
      const outCH = Math.round(s.h);
      const origCell = { x: s._origX, y: s._origY, w: s._origW, h: s._origH };
      const canvas = sliceToCanvas(state.image, origCell, outCW, outCH, state.annotations, getCellThumb(s));
      const blob = await canvasToBlob(canvas, eo.mimeType, eo.quality);
      const fname = `${base}_${String(step).padStart(2, '0')}${eo.ext}`;
      const result = await uploadToCloudinary(blob, cloudName, uploadPreset, fname);
      cdnUrls[cellKey(s)] = result.secure_url;
      await new Promise(r => setTimeout(r, 0));
    }

    // Phase 2: Upload single full image for Outlook/Apple version
    step++;
    if (onProgress) onProgress(step, totalSteps, 'Outlook');
    const { canvas: fullCanvas, ctx: fullCtx } = getSliceCanvas(outW, outH);
    fullCtx.imageSmoothingEnabled = true;
    fullCtx.imageSmoothingQuality = 'high';
    fullCtx.drawImage(state.image, 0, 0, natW, natH, 0, 0, outW, outH);
    if (state.annotations && state.annotations.length) {
      const sx = outW / natW, sy = outH / natH;
      fullCtx.textBaseline = 'top';
      state.annotations.forEach(a => {
        const ax = a.x * sx, ay = a.y * sy;
        const fs = Math.round((a.fontSize || 16) * sx);
        fullCtx.font = `${a.bold ? 'bold ' : ''}${a.italic ? 'italic ' : ''}${fs}px Arial,sans-serif`;
        fullCtx.fillStyle = a.color || '#ffffff';
        const lines = (a.text || '').split('\n');
        const lh = Math.round(fs * 1.3);
        lines.forEach((line, li) => fullCtx.fillText(line, ax, ay + li * lh));
      });
    }
    const fullBlob = await canvasToBlob(fullCanvas, eo.mimeType, eo.quality);
    releaseSliceCanvas();
    const fullResult = await uploadToCloudinary(fullBlob, cloudName, uploadPreset, `${base}_full${eo.ext}`);
    const fullImgUrl = fullResult.secure_url;

    // --- Build File 1: Gmail table-sliced HTML (CDN URLs) ---
    const gmailHtml = buildHTMLDoc(scaledState, {
      client: null,
      defaultLink: eo.defaultLink,
      bodyBgColor: eo.bodyBgColor,
      gridRows: _gridRows,
      imageSrc: s => cdnUrls[cellKey(s)] || '',
    });

    // --- Build File 2: Outlook/Apple image map HTML ---
    const scaleX = eo.scale, scaleYv = eo.scaleY;
    let areas = '';
    const linkedSlices = state.slices.filter(s => s.href && s.type !== 'text');
    linkedSlices.forEach(s => {
      const x1 = Math.round(s.x * scaleX), y1 = Math.round(s.y * scaleYv);
      const x2 = Math.round((s.x + s.w) * scaleX), y2 = Math.round((s.y + s.h) * scaleYv);
      areas += `<area shape="rect" coords="${x1},${y1},${x2},${y2}" href="${escapeAttr(s.href)}" alt="${escapeAttr(s.alt || 'Slice ' + s.id)}" target="_blank" />`;
    });
    if (eo.defaultLink) {
      areas += `<area shape="rect" coords="0,0,${outW},${outH}" href="${escapeAttr(eo.defaultLink)}" alt="Email" target="_blank" />`;
    }

    const bgColor = eo.bodyBgColor || '';
    const hasBg = bgColor && bgColor !== 'transparent' && bgColor !== 'none';
    const bodyBgStyle = hasBg ? `background:${bgColor};` : '';

    const outlookHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>EDM</title>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style type="text/css">
:root{color-scheme:light only;}
body{margin:0;padding:0;${bodyBgStyle}-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
img{display:block !important;vertical-align:middle !important;border:0 none;outline:none;text-decoration:none;line-height:0px !important;font-size:0px !important;-ms-interpolation-mode:bicubic;}
a{text-decoration:none;}
table{border-collapse:collapse;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;}
</style>
</head>
<body style="margin:0;padding:0;${bodyBgStyle}">` +
(hasBg ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bgColor}" style="margin:0;padding:0;border:0 none;border-collapse:collapse;background-color:${bgColor};"><tr><td align="center" valign="top" style="padding:0;border:0 none;">` : '') +
`<!--[if mso]><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="${outW}"><tr><td><![endif]-->` +
(outW > 640
  ? `<div style="width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 auto;">` +
    `<div style="width:${outW}px;min-width:${outW}px;max-width:${outW}px;margin:0 auto;font-size:0;line-height:0;">` +
    `<img src="${escapeAttr(fullImgUrl)}" width="${outW}" height="${outH}" alt="${escapeAttr(base)}" border="0" usemap="#edm-map" style="display:block;width:${outW}px;min-width:${outW}px;max-width:${outW}px;height:auto;border:0 none;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />` +
    `<map name="edm-map">${areas}</map>` +
    `</div></div>`
  : `<div style="max-width:${outW}px;margin:0 auto;font-size:0;line-height:0;">` +
    `<img src="${escapeAttr(fullImgUrl)}" width="${outW}" height="${outH}" alt="${escapeAttr(base)}" border="0" usemap="#edm-map" style="display:block;width:100%;max-width:${outW}px;height:auto;border:0 none;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />` +
    `<map name="edm-map">${areas}</map>` +
    `</div>`
) +
`<!--[if mso]></td></tr></table><![endif]-->` +
(hasBg ? `</td></tr></table>` : '') +
`</body></html>`;

    // Download both files
    triggerDownload(new Blob([gmailHtml], { type: 'text/html' }), `${base}_gmail.html`);
    await new Promise(r => setTimeout(r, 300));
    triggerDownload(new Blob([outlookHtml], { type: 'text/html' }), `${base}_outlook_apple.html`);

    return { gmailHtml, outlookHtml, cdnUrl: fullImgUrl, imageCount: cells.length + 1, linkedSlices: linkedSlices.length };
  }

  window.EDMExporter = {
    buildHTML, exportZip, exportEml, exportOft,
    exportMailchimp, exportGmailClipboard, exportSES, exportRawHtml,
    exportGmailImage, exportGmailHtml,
    testCloudinary, exportCloudinary,
  };
})();
