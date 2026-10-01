import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['slides_create', 'slides_add_slide', 'slides_update_slide', 'slides_delete_slide', 'slides_get'] as const;

function riskFor(action: string): ToolRisk {
  if (action.includes('delete')) return 'delete';
  if (action.includes('get') || action.includes('fetch') || action.includes('read')) return 'read';
  return 'draft';
}

interface SlideInput {
  slideIndex?: number;
  slideId?: string;
  title?: string;
  body?: string | string[];
  content?: string | string[];
}

export interface SlidesParsedText {
  cleanText: string;
  boldRanges: Array<{ startIndex: number; endIndex: number }>;
}

export function parseMarkdownToSlidesText(rawText: string | string[]): SlidesParsedText {
  const lines = Array.isArray(rawText) ? rawText : String(rawText || '').split('\n');
  let fullCleanText = '';
  const boldRanges: Array<{ startIndex: number; endIndex: number }> = [];

  for (const l of lines) {
    let line = l.trim();
    if (!line) continue;

    let isBullet = false;
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      line = line.slice(2).trim();
      isBullet = true;
    }

    const bulletPrefix = isBullet ? '• ' : '';
    const prefixOffset = fullCleanText.length > 0 ? 1 : 0;
    let lineCleanText = bulletPrefix;
    let lineCursor = fullCleanText.length + prefixOffset + bulletPrefix.length;

    const regex = /\*\*([^*]+)\*\*/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const preText = line.slice(lastIdx, match.index);
      lineCleanText += preText;
      lineCursor += preText.length;

      const boldText = match[1];
      const start = lineCursor;
      lineCleanText += boldText;
      lineCursor += boldText.length;
      boldRanges.push({ startIndex: start, endIndex: lineCursor });

      lastIdx = regex.lastIndex;
    }

    lineCleanText += line.slice(lastIdx);
    fullCleanText += (fullCleanText.length > 0 ? '\n' : '') + lineCleanText;
  }

  return { cleanText: fullCleanText, boldRanges };
}

function buildSlideContentRequests(
  targetSlideId: string,
  slide: SlideInput,
  idx: number,
  prefix: string
): Array<Record<string, unknown>> {
  const titleBoxId = `title_${prefix}_${idx}`;
  const bodyBoxId = `body_${prefix}_${idx}`;

  const rawTitle = typeof slide.title === 'string' ? slide.title.trim() : '';
  const cleanTitle = rawTitle.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();

  const rawBody = slide.body || slide.content || '';
  const parsedBody = parseMarkdownToSlidesText(rawBody);

  const reqs: Array<Record<string, unknown>> = [];

  if (cleanTitle) {
    reqs.push(
      {
        createShape: {
          objectId: titleBoxId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: targetSlideId,
            size: { height: { magnitude: 55, unit: 'PT' }, width: { magnitude: 650, unit: 'PT' } },
            transform: { scaleX: 1, scaleY: 1, translateX: 35, translateY: 25, unit: 'PT' },
          },
        },
      },
      {
        insertText: {
          objectId: titleBoxId,
          text: cleanTitle,
        },
      },
      {
        updateTextStyle: {
          objectId: titleBoxId,
          textRange: { type: 'ALL' },
          style: {
            bold: true,
            fontSize: { magnitude: 22, unit: 'PT' },
            fontFamily: 'Arial',
            foregroundColor: {
              opaqueColor: { rgbColor: { red: 0.1, green: 0.14, blue: 0.2 } },
            },
          },
          fields: 'bold,fontSize,fontFamily,foregroundColor',
        },
      }
    );
  }

  if (parsedBody.cleanText) {
    reqs.push(
      {
        createShape: {
          objectId: bodyBoxId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: targetSlideId,
            size: { height: { magnitude: 275, unit: 'PT' }, width: { magnitude: 650, unit: 'PT' } },
            transform: { scaleX: 1, scaleY: 1, translateX: 35, translateY: 85, unit: 'PT' },
          },
        },
      },
      {
        insertText: {
          objectId: bodyBoxId,
          text: parsedBody.cleanText,
        },
      },
      {
        updateTextStyle: {
          objectId: bodyBoxId,
          textRange: { type: 'ALL' },
          style: {
            fontSize: { magnitude: 13, unit: 'PT' },
            fontFamily: 'Arial',
            foregroundColor: {
              opaqueColor: { rgbColor: { red: 0.25, green: 0.3, blue: 0.38 } },
            },
          },
          fields: 'fontSize,fontFamily,foregroundColor',
        },
      },
      {
        updateParagraphStyle: {
          objectId: bodyBoxId,
          textRange: { type: 'ALL' },
          style: {
            lineSpacing: 130,
            spaceBelow: { magnitude: 8, unit: 'PT' },
          },
          fields: 'lineSpacing,spaceBelow',
        },
      }
    );

    for (const r of parsedBody.boldRanges) {
      if (r.startIndex < r.endIndex) {
        reqs.push({
          updateTextStyle: {
            objectId: bodyBoxId,
            textRange: {
              type: 'FIXED_RANGE',
              startIndex: r.startIndex,
              endIndex: r.endIndex,
            },
            style: {
              bold: true,
              foregroundColor: {
                opaqueColor: { rgbColor: { red: 0.1, green: 0.14, blue: 0.2 } },
              },
            },
            fields: 'bold,foregroundColor',
          },
        });
      }
    }
  }

  return reqs;
}

function buildSlideRequests(
  slide: SlideInput,
  idx: number,
  prefix: string
): Array<Record<string, unknown>> {
  const slideId = `slide_${prefix}_${idx}`;
  const defaultTitle = typeof slide.title === 'string' ? slide.title : `Slide ${idx + 1}`;
  const slideWithTitle = { ...slide, title: defaultTitle };

  return [
    {
      createSlide: {
        objectId: slideId,
        slideLayoutReference: {
          predefinedLayout: 'BLANK',
        },
      },
    },
    ...buildSlideContentRequests(slideId, slideWithTitle, idx, prefix),
  ];
}

async function execute(ctx: ToolActionContext) {
  let { actionName } = ctx;
  const { payload, orgId, timestamp } = ctx;
  const _gAuth = await resolveGoogleAuth(orgId, 'google-slides');
  const gToken: string | null = _gAuth.kind === 'connected' ? _gAuth.accessToken : null;
  const _gAuthErr = _gAuth.kind === 'connected' ? null : nangoAuthError('google-slides', actionName, timestamp, _gAuth);
  if (!gToken) return _gAuthErr ?? notConnected('google-slides', actionName, timestamp);

  try {
    // ── 1. Create Presentation ───────────────────────────────────────────
    if (actionName === 'slides_create' || actionName.includes('create')) {
      const title = payload.title || 'Untitled Presentation';
      const slidesRes = await fetchWithTimeout('https://slides.googleapis.com/v1/presentations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!slidesRes.ok) {
        return {
          tool: 'google-slides',
          action: 'slides_create',
          status: 'error' as const,
          message: `Slides error ${slidesRes.status}: ${await slidesRes.text()}`,
          data: null,
          timestamp,
        };
      }
      const slidesData = await slidesRes.json();
      const presentationId = slidesData.presentationId;
      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;

      const initialSlideId = slidesData.slides?.[0]?.objectId;
      const rawSlides: SlideInput[] = Array.isArray(payload.slides) ? payload.slides : [];

      let slidesAdded = 0;
      if (rawSlides.length > 0) {
        const prefix = Date.now().toString(36);
        const batchReqs: Array<Record<string, unknown>> = [];

        rawSlides.forEach((s, idx) => {
          batchReqs.push(...buildSlideRequests(s, idx, prefix));
        });

        // If user provided custom slides, remove default initial blank slide
        if (initialSlideId && (payload.deleteExisting !== false)) {
          batchReqs.push({ deleteObject: { objectId: initialSlideId } });
        }

        try {
          const batchRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: batchReqs }),
          });
          if (batchRes.ok) {
            slidesAdded = rawSlides.length;
          } else {
            console.warn('[google-slides] batchUpdate failed during create:', await batchRes.text());
          }
        } catch (batchErr: any) {
          console.warn('[google-slides] batchUpdate exception:', batchErr?.message);
        }
      }

      return {
        tool: 'google-slides',
        action: 'slides_create',
        status: 'executed' as const,
        message: `Created presentation "${slidesData.title}"${slidesAdded > 0 ? ` with ${slidesAdded} slides` : ''}: ${url}`,
        data: {
          presentationId,
          title: slidesData.title,
          url,
          slidesCount: slidesAdded || (slidesData.slides?.length ?? 1),
        },
        timestamp,
      };
    }

    // ── 2. Add Slide to Existing Presentation ────────────────────────────
    if (actionName === 'slides_add_slide' || actionName.includes('add')) {
      // If caller passed slideIndex or slideId, delegate to slides_update_slide
      if (payload.slideIndex !== undefined || payload.slideId !== undefined) {
        actionName = 'slides_update_slide';
      } else {
        const presentationId = payload.presentationId || payload.id;
        if (!presentationId) {
          return {
            tool: 'google-slides',
            action: 'slides_add_slide',
            status: 'error' as const,
            message: 'presentationId is required to add a slide.',
            data: null,
            timestamp,
          };
        }

        const rawSlides: SlideInput[] = Array.isArray(payload.slides)
          ? payload.slides
          : [{ title: payload.title, body: payload.body || payload.content }];

        const prefix = Date.now().toString(36);
        const batchReqs: Array<Record<string, unknown>> = [];
        rawSlides.forEach((s, idx) => {
          batchReqs.push(...buildSlideRequests(s, idx, prefix));
        });

        const batchRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: batchReqs }),
        });

        const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;
        if (!batchRes.ok) {
          return {
            tool: 'google-slides',
            action: 'slides_add_slide',
            status: 'error' as const,
            message: `Failed to add slide(s): ${await batchRes.text()}`,
            data: { presentationId, url },
            timestamp,
          };
        }

        return {
          tool: 'google-slides',
          action: 'slides_add_slide',
          status: 'executed' as const,
          message: `Added ${rawSlides.length} slide(s) to presentation: ${url}`,
          data: { presentationId, url, addedCount: rawSlides.length },
          timestamp,
        };
      }
    }

    // ── 3. Update / Set Content on Existing Slide(s) ──────────────────────
    if (actionName === 'slides_update_slide' || actionName.includes('update') || actionName.includes('edit')) {
      const presentationId = payload.presentationId || payload.id;
      if (!presentationId) {
        return {
          tool: 'google-slides',
          action: 'slides_update_slide',
          status: 'error' as const,
          message: 'presentationId is required to update a slide.',
          data: null,
          timestamp,
        };
      }

      // Fetch presentation to inspect existing slide structure
      const presRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!presRes.ok) {
        return {
          tool: 'google-slides',
          action: 'slides_update_slide',
          status: 'error' as const,
          message: `Failed to fetch presentation ${presentationId}: ${await presRes.text()}`,
          data: null,
          timestamp,
        };
      }
      const presData = await presRes.json();
      const existingSlides: any[] = presData.slides || [];
      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;

      const rawUpdates: Array<{
        slideIndex?: number;
        slideId?: string;
        title?: string;
        body?: string | string[];
        content?: string | string[];
      }> = Array.isArray(payload.slides) && payload.slides.length > 0
        ? payload.slides
        : [{
            slideIndex: typeof payload.slideIndex === 'number' ? payload.slideIndex : (payload.slideId ? undefined : 0),
            slideId: payload.slideId || payload.objectId,
            title: payload.title,
            body: payload.body || payload.content,
          }];

      const prefix = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      const batchReqs: Array<Record<string, unknown>> = [];
      let updatedCount = 0;

      for (let idx = 0; idx < rawUpdates.length; idx++) {
        const item = rawUpdates[idx];
        let targetSlide: any = null;
        if (item.slideId) {
          targetSlide = existingSlides.find((s) => s.objectId === item.slideId);
        } else if (typeof item.slideIndex === 'number') {
          targetSlide = existingSlides[item.slideIndex];
        } else if (existingSlides[idx]) {
          targetSlide = existingSlides[idx];
        }

        if (targetSlide) {
          // Clear existing shapes on the slide so updated text does not overlap
          if (Array.isArray(targetSlide.pageElements)) {
            for (const elem of targetSlide.pageElements) {
              if (elem.objectId) {
                batchReqs.push({ deleteObject: { objectId: elem.objectId } });
              }
            }
          }
          batchReqs.push(...buildSlideContentRequests(targetSlide.objectId, item, idx, prefix));
          updatedCount++;
        } else {
          // If the requested slide index does not exist yet, create a new slide with content
          batchReqs.push(...buildSlideRequests(item, idx, prefix));
          updatedCount++;
        }
      }

      if (batchReqs.length === 0) {
        return {
          tool: 'google-slides',
          action: 'slides_update_slide',
          status: 'executed' as const,
          message: `No modifications needed for presentation: ${url}`,
          data: { presentationId, url, updatedCount: 0 },
          timestamp,
        };
      }

      const batchRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: batchReqs }),
      });

      if (!batchRes.ok) {
        return {
          tool: 'google-slides',
          action: 'slides_update_slide',
          status: 'error' as const,
          message: `Failed to update slide(s): ${await batchRes.text()}`,
          data: { presentationId, url },
          timestamp,
        };
      }

      return {
        tool: 'google-slides',
        action: 'slides_update_slide',
        status: 'executed' as const,
        message: `Updated content on ${updatedCount} slide(s) in presentation: ${url}`,
        data: { presentationId, url, updatedCount },
        timestamp,
      };
    }

    // ── 3. Delete Slide from Existing Presentation ───────────────────────
    if (actionName === 'slides_delete_slide' || actionName.includes('delete')) {
      const presentationId = payload.presentationId || payload.id;
      if (!presentationId) {
        return {
          tool: 'google-slides',
          action: 'slides_delete_slide',
          status: 'error' as const,
          message: 'presentationId is required to delete a slide.',
          data: null,
          timestamp,
        };
      }

      let slideIdToDelete = payload.slideId || payload.objectId;
      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;

      if (!slideIdToDelete) {
        // Fetch presentation to find slide by index
        const presRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}`, {
          headers: { Authorization: `Bearer ${gToken}` },
        });
        if (presRes.ok) {
          const presData = await presRes.json();
          const slides = presData.slides || [];
          const idx = typeof payload.slideIndex === 'number' ? payload.slideIndex : 0;
          if (slides[idx]) {
            slideIdToDelete = slides[idx].objectId;
          }
        }
      }

      if (!slideIdToDelete) {
        return {
          tool: 'google-slides',
          action: 'slides_delete_slide',
          status: 'error' as const,
          message: 'Could not find a slide to delete (specify slideId or slideIndex).',
          data: { presentationId, url },
          timestamp,
        };
      }

      const batchRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ deleteObject: { objectId: slideIdToDelete } }] }),
      });

      if (!batchRes.ok) {
        return {
          tool: 'google-slides',
          action: 'slides_delete_slide',
          status: 'error' as const,
          message: `Failed to delete slide: ${await batchRes.text()}`,
          data: { presentationId, url },
          timestamp,
        };
      }

      return {
        tool: 'google-slides',
        action: 'slides_delete_slide',
        status: 'executed' as const,
        message: `Deleted slide from presentation: ${url}`,
        data: { presentationId, deletedSlideId: slideIdToDelete, url },
        timestamp,
      };
    }

    // ── 4. Fetch Presentation Details & Slides ────────────────────────────
    if (actionName === 'slides_get' || actionName.includes('get') || actionName.includes('read') || actionName.includes('fetch')) {
      const presentationId = payload.presentationId || payload.id;
      if (!presentationId) {
        return {
          tool: 'google-slides',
          action: 'slides_get',
          status: 'error' as const,
          message: 'presentationId is required to fetch presentation details.',
          data: null,
          timestamp,
        };
      }
      const presRes = await fetchWithTimeout(`https://slides.googleapis.com/v1/presentations/${presentationId}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!presRes.ok) {
        return {
          tool: 'google-slides',
          action: 'slides_get',
          status: 'error' as const,
          message: `Failed to fetch presentation: ${await presRes.text()}`,
          data: null,
          timestamp,
        };
      }
      const presData = await presRes.json();
      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;
      const slidesSummary = (presData.slides || []).map((s: any, idx: number) => {
        const texts: string[] = [];
        for (const elem of s.pageElements || []) {
          const textObj = elem.shape?.text;
          if (textObj?.textElements) {
            for (const te of textObj.textElements) {
              if (te.textRun?.content) {
                const trimmed = te.textRun.content.trim();
                if (trimmed) texts.push(trimmed);
              }
            }
          }
        }
        return {
          slideIndex: idx,
          slideId: s.objectId,
          text: texts.join(' | '),
        };
      });
      return {
        tool: 'google-slides',
        action: 'slides_get',
        status: 'executed' as const,
        message: `Fetched presentation "${presData.title}" (${presData.slides?.length || 0} slides): ${url}`,
        data: {
          presentationId,
          title: presData.title,
          url,
          slidesCount: presData.slides?.length || 0,
          slides: slidesSummary,
        },
        timestamp,
      };
    }

    return {
      tool: 'google-slides',
      action: actionName,
      status: 'error' as const,
      message: `Unknown action "${actionName}" for google-slides.`,
      data: null,
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-slides] API error:', e.message);
    return {
      tool: 'google-slides',
      action: actionName,
      status: 'error' as const,
      message: `google-slides request failed: ${e.message}`,
      data: null,
      timestamp,
    };
  }
}

export const googleSlides: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
