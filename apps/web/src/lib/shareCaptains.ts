/**
 * The shareable "Captain Battle · GW N" picture (admin → Captain Battle → Share): a 1080×1350 PNG drawn on a canvas.
 * Brand colours come from the theme tokens (CSS variables), the font is the app's self-hosted Rubik, Hebrew is drawn
 * right-to-left. Player photos come through the same-origin `/fplimg/` proxy (vercel.json) so they don't taint the
 * canvas; a photo that fails to load is replaced by the player's initials. The QR code library is imported lazily
 * here and nowhere else. No React: the sheet (screens/admin/ShareCaptains.tsx) only calls `renderShareImage`.
 */

export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1350;
/** At most this many rows fit the picture. */
export const SHARE_MAX_ROWS = 6;

export interface ShareImageRow {
  /** The row's name in the battle ("הקפטן של דור"). */
  label: string;
  /** Null = not known yet (the hosts' picks stay hidden by FPL until the deadline). */
  name: string | null;
  initials: string;
  /** Same-origin photo URLs, best first. */
  photos: readonly string[];
  club: string | null;
  opponent: string | null;
  /** The badge text ("קהילה"); null = none. */
  tag: string | null;
  /** The FPL Lad row carries its logo. */
  fplLad: boolean;
}

export interface ShareImageData {
  rtl: boolean;
  brand: string;
  title: string;
  gw: string;
  revealText: string;
  ctaText: string;
  /** The link as printed under the call to action ("host/community/?view=captain"). */
  shortUrl: string;
  /** What the QR code encodes. */
  deepLink: string;
  logoSrc: string;
  fplLadSrc: string;
  rows: readonly ShareImageRow[];
  /** Set = the "vote invitation" poster: no captains, the text below instead of the rows. */
  vote?: ShareVoteInvite;
}

/** The vote-invitation poster's own lines (the title / gw / cta / links come from `ShareImageData`). */
export interface ShareVoteInvite {
  tagline: string;
  /** "ההצבעה נסגרת ב־21 בנוב׳ ב־13:00"; null = no deadline known. */
  deadline: string | null;
  /** "7 כבר הצביעו"; null when nobody voted yet. */
  voters: string | null;
}

/** The photo of a player through the same-origin proxy (`/fplimg/:path*` → resources.premierleague.com). */
export function proxiedPhotoUrls(photoCode: string): string[] {
  const code = photoCode.replace(/\.(png|jpg)$/i, '');
  return [250, '110x140'].map((size) =>
    size === 250
      ? `/fplimg/premierleague/photos/players/250x250/p${code}.png`
      : `/fplimg/premierleague/photos/players/${size}/p${code}.png`,
  );
}

/** The deep link a click on the shared post should land on: the captain vote sub-tab of the Community tab. */
export function captainVoteLink(origin: string): { link: string; short: string } {
  const base = origin.replace(/\/+$/, '');
  return {
    link: `${base}/community/?view=captain`,
    short: `${base.replace(/^https?:\/\//, '')}/community/?view=captain`,
  };
}

/** The production web address: what every shared link and QR code points at (never a preview or native origin). */
export const PRODUCTION_SITE_URL = 'https://fantasyonerim.vercel.app';

/** `NEXT_PUBLIC_SITE_URL` when set; the page's own origin on localhost / 127.0.0.1 (dev, e2e); else production. */
export function resolveSiteOrigin(env: string | undefined, hostname: string, origin: string): string {
  if (env) return env;
  return hostname === 'localhost' || hostname === '127.0.0.1' ? origin : PRODUCTION_SITE_URL;
}

export function siteOrigin(): string {
  return resolveSiteOrigin(
    process.env.NEXT_PUBLIC_SITE_URL,
    window.location.hostname,
    window.location.origin,
  );
}

// ---------- drawing helpers ----------

interface Palette {
  purple: string;
  mint: string;
  offwhite: string;
  plate: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    purple: v('--brand-purple'),
    mint: v('--brand-mint'),
    offwhite: v('--brand-offwhite'),
    plate: v('--logo-chip'),
  };
}

/** "#c7efd5" + 0.3 → "rgb(199 239 213 / 0.3)" (token values are plain hex). */
function alpha(color: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m?.[1]) return color;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}

function loadImage(src: string, timeoutMs = 8_000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => done(null), timeoutMs);
    function done(v: HTMLImageElement | null) {
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(v);
    }
    img.onload = () => done(img.naturalWidth > 0 ? img : null);
    img.onerror = () => done(null);
    img.src = src;
  });
}

async function firstImage(urls: readonly string[]): Promise<HTMLImageElement | null> {
  for (const u of urls) {
    const img = await loadImage(u);
    if (img) return img;
  }
  return null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Shortens `text` with an ellipsis until it fits `maxWidth` in the context's current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

async function loadFonts(family: string): Promise<void> {
  const sample =
    'אבגדהוזחטיכלמנסעפצקרשת ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ·()';
  try {
    await Promise.all([400, 600, 800].map((w) => document.fonts.load(`${w} 40px ${family}`, sample)));
    await document.fonts.ready;
  } catch {
    // The system font draws instead; the picture is still valid.
  }
}

/** Renders the picture. Rejects only if the canvas itself can't produce a PNG. */
export async function renderShareImage(data: ShareImageData): Promise<Blob> {
  const W = SHARE_WIDTH;
  const H = SHARE_HEIGHT;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const pal = readPalette();
  const { rtl } = data;

  const [, logo, fplLad, photos, qr] = await Promise.all([
    loadFonts(family),
    loadImage(data.logoSrc),
    loadImage(data.fplLadSrc),
    Promise.all(data.rows.slice(0, SHARE_MAX_ROWS).map((r) => firstImage(r.photos))),
    import('uqr').then((m) => m.encode(data.deepLink, { ecc: 'M', border: 0 })),
  ]);

  const font = (weight: number, px: number) => `${weight} ${px}px ${family}`;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textBaseline = 'alphabetic';
  /** Anchor x for text that starts `offset` px from the START edge (the right edge in Hebrew). */
  const sx = (offset: number) => (rtl ? W - offset : offset);
  /** Left x of a box that starts `offset` px from the start edge and is `w` wide. */
  const boxX = (offset: number, w: number) => (rtl ? W - offset - w : offset);
  const text = (s: string, x: number, y: number, align: 'start' | 'end' | 'center' = 'start') => {
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
  };

  // ----- background: brand purple with a soft mint glow and a light diagonal sheen -----
  ctx.fillStyle = pal.purple;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, -80, 40, W * 0.85, -80, 900);
  glow.addColorStop(0, alpha(pal.mint, 0.28));
  glow.addColorStop(1, alpha(pal.mint, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  const glow2 = ctx.createRadialGradient(W * 0.1, H + 60, 40, W * 0.1, H + 60, 800);
  glow2.addColorStop(0, alpha(pal.offwhite, 0.1));
  glow2.addColorStop(1, alpha(pal.offwhite, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ----- header: logo + brand, the title and the gameweek pill -----
  const M = 56;
  const logoD = 104;
  ctx.font = font(800, 54);
  const brandW = ctx.measureText(data.brand).width;
  const groupW = logoD + 24 + brandW;
  const groupStart = (W - groupW) / 2; // from the left edge of the picture
  const logoLeft = rtl ? groupStart + groupW - logoD : groupStart;
  const logoCy = 48 + logoD / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(logoLeft + logoD / 2, logoCy, logoD / 2, 0, Math.PI * 2);
  ctx.fillStyle = pal.mint;
  ctx.fill();
  ctx.clip();
  if (logo) ctx.drawImage(logo, logoLeft, logoCy - logoD / 2, logoD, logoD);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(logoLeft + logoD / 2, logoCy, logoD / 2, 0, Math.PI * 2);
  ctx.strokeStyle = alpha(pal.mint, 0.7);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = pal.offwhite;
  ctx.font = font(800, 54);
  text(data.brand, rtl ? logoLeft - 24 : logoLeft + logoD + 24, logoCy + 19, 'start');

  ctx.fillStyle = pal.offwhite;
  // A long headline shrinks to fit instead of being cut.
  let titleSize = 92;
  ctx.font = font(800, titleSize);
  while (titleSize > 52 && ctx.measureText(data.title).width > W - 2 * M) {
    titleSize -= 4;
    ctx.font = font(800, titleSize);
  }
  text(fit(ctx, data.title, W - 2 * M), W / 2, 282, 'center');

  ctx.font = font(700, 40);
  const pillTextW = ctx.measureText(data.gw).width;
  const pillW = pillTextW + 72;
  const pillX = (W - pillW) / 2;
  roundRect(ctx, pillX, 312, pillW, 64, 32);
  ctx.fillStyle = pal.mint;
  ctx.fill();
  ctx.fillStyle = pal.purple;
  text(data.gw, W / 2, 312 + 45, 'center');

  const innerW = W - 2 * M;
  if (data.vote) {
    // ----- the vote invitation: a ballot medallion of empty "?" slots instead of captains -----
    const v = data.vote;
    const cy = 590;
    const slot = (cx: number, d: number, strong: boolean) => {
      ctx.beginPath();
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = alpha(pal.offwhite, strong ? 0.12 : 0.07);
      ctx.fill();
      ctx.setLineDash(strong ? [] : [10, 10]);
      ctx.lineWidth = strong ? 6 : 3;
      ctx.strokeStyle = alpha(pal.mint, strong ? 0.9 : 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = strong ? pal.mint : alpha(pal.mint, 0.55);
      ctx.font = font(800, Math.round(d * 0.62));
      ctx.direction = 'ltr';
      text('?', cx, cy + d * 0.22, 'center');
      ctx.direction = rtl ? 'rtl' : 'ltr';
    };
    const halo = ctx.createRadialGradient(W / 2, cy, 120, W / 2, cy, 420);
    halo.addColorStop(0, alpha(pal.mint, 0.22));
    halo.addColorStop(1, alpha(pal.mint, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, cy - 420, W, 840);
    slot(W / 2 - 330, 150, false);
    slot(W / 2 + 330, 150, false);
    slot(W / 2, 300, true);

    ctx.fillStyle = pal.offwhite;
    ctx.font = font(700, 46);
    const tagWords = v.tagline.split(' ');
    const tagLines: string[] = [];
    let tagCur = '';
    for (const w of tagWords) {
      const next = tagCur ? `${tagCur} ${w}` : w;
      if (ctx.measureText(next).width <= innerW - 40 || !tagCur) tagCur = next;
      else {
        tagLines.push(tagCur);
        tagCur = w;
      }
    }
    if (tagCur) tagLines.push(tagCur);
    let ly = 830;
    for (const l of tagLines.slice(0, 2)) {
      text(fit(ctx, l, innerW - 40), W / 2, ly, 'center');
      ly += 60;
    }
    let infoY = Math.max(ly + 24, 936);
    if (v.deadline) {
      ctx.font = font(700, 34);
      const dw = Math.min(innerW, ctx.measureText(v.deadline).width + 80);
      roundRect(ctx, (W - dw) / 2, infoY - 44, dw, 72, 36);
      ctx.fillStyle = alpha(pal.offwhite, 0.1);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = alpha(pal.mint, 0.35);
      ctx.stroke();
      ctx.fillStyle = pal.offwhite;
      text(fit(ctx, v.deadline, dw - 60), W / 2, infoY, 'center');
      infoY += 76;
    }
    if (v.voters) {
      ctx.fillStyle = pal.mint;
      ctx.font = font(700, 34);
      text(v.voters, W / 2, infoY, 'center');
    }
  } else {
    // ----- the captain rows -----
    const rows = data.rows.slice(0, SHARE_MAX_ROWS);
    const top = 412;
    const bottom = 1096;
    const gap = 14;
    const rowH = Math.min(
      158,
      Math.floor((bottom - top - gap * (rows.length - 1)) / Math.max(rows.length, 1)),
    );
    const photoD = rowH - 28;
    const nameSize = Math.max(30, Math.min(46, Math.round(rowH * 0.31)));
    const smallSize = Math.max(22, Math.round(nameSize * 0.6));

    rows.forEach((row, i) => {
      const y = top + i * (rowH + gap);
      roundRect(ctx, M, y, innerW, rowH, 30);
      ctx.fillStyle = alpha(pal.offwhite, 0.09);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = alpha(pal.mint, 0.25);
      ctx.stroke();

      // photo (or initials / "?")
      const cx = boxX(M + 14, photoD) + photoD / 2;
      const cy = y + rowH / 2;
      const known = row.name !== null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, photoD / 2, 0, Math.PI * 2);
      ctx.fillStyle = known ? pal.mint : alpha(pal.offwhite, 0.12);
      ctx.fill();
      const photo = photos[i];
      if (known && photo) {
        ctx.clip();
        // A square cut from the top (the 110×140 portraits keep the face, the 250×250 ones are already square).
        const side = Math.min(photo.naturalWidth, photo.naturalHeight);
        ctx.drawImage(
          photo,
          (photo.naturalWidth - side) / 2,
          0,
          side,
          side,
          cx - photoD / 2,
          cy - photoD / 2,
          photoD,
          photoD,
        );
        ctx.restore();
      } else {
        ctx.restore();
        if (!known) {
          ctx.setLineDash([8, 8]);
          ctx.lineWidth = 3;
          ctx.strokeStyle = alpha(pal.mint, 0.6);
          ctx.beginPath();
          ctx.arc(cx, cy, photoD / 2 - 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = known ? pal.purple : pal.mint;
        ctx.font = font(800, Math.round(photoD * 0.38));
        text(known ? row.initials : '?', cx, cy + photoD * 0.14, 'center');
      }
      ctx.beginPath();
      ctx.arc(cx, cy, photoD / 2, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = alpha(pal.offwhite, 0.85);
      ctx.stroke();

      // tag pill at the end of the row
      let tagW = 0;
      const tagH = 40;
      const tagText = row.tag;
      if (tagText !== null || row.fplLad) {
        ctx.font = font(700, 24);
        const logoH = 28;
        const logoW =
          row.fplLad && fplLad ? Math.round((fplLad.naturalWidth / fplLad.naturalHeight) * logoH) : 0;
        const textW = tagText ? Math.min(ctx.measureText(tagText).width, 190) : 0;
        tagW = 28 + logoW + (logoW && textW ? 10 : 0) + textW;
        // The chip hangs on the end side of the row (mirrored in Hebrew: on the left).
        const chipX = rtl ? M + 22 : W - M - 22 - tagW;
        roundRect(ctx, chipX, cy - tagH / 2, tagW, tagH, tagH / 2);
        ctx.fillStyle = row.fplLad ? pal.plate : alpha(pal.mint, 0.2);
        ctx.fill();
        let cursor = rtl ? chipX + tagW - 14 : chipX + 14; // start side of the content inside the chip
        const placeInChip = (w: number) => {
          const left = rtl ? cursor - w : cursor;
          cursor = rtl ? cursor - w : cursor + w;
          return left;
        };
        if (logoW && fplLad) {
          ctx.drawImage(fplLad, placeInChip(logoW), cy - logoH / 2, logoW, logoH);
          if (textW) placeInChip(10);
        }
        if (tagText) {
          ctx.fillStyle = row.fplLad ? pal.purple : pal.mint;
          ctx.font = font(700, 24);
          const shown = fit(ctx, tagText, 190);
          const w = ctx.measureText(shown).width;
          const left = placeInChip(w);
          text(shown, rtl ? left + w : left, cy + 8, 'start');
        }
      }

      // text block between the photo and the tag
      const textStart = M + 14 + photoD + 22;
      const textMax = innerW - (textStart - M) - (tagW ? tagW + 44 : 22);
      const anchor = sx(textStart);
      const blockH = smallSize + 8 + nameSize + 8 + smallSize;
      let ty = y + (rowH - blockH) / 2 + smallSize - 2;
      ctx.fillStyle = alpha(pal.mint, 0.95);
      ctx.font = font(600, smallSize);
      text(fit(ctx, row.label, textMax), anchor, ty, 'start');
      ty += 8 + nameSize;
      ctx.fillStyle = known ? pal.offwhite : alpha(pal.offwhite, 0.75);
      ctx.font = font(800, nameSize);
      text(fit(ctx, known ? (row.name ?? '') : data.revealText, textMax), anchor, ty, 'start');
      ty += 8 + smallSize;
      ctx.fillStyle = alpha(pal.offwhite, 0.78);
      ctx.font = font(400, smallSize);
      const sub = [row.club, row.opponent].filter((p): p is string => !!p).join(' · ');
      if (known && sub) text(fit(ctx, sub, textMax), anchor, ty, 'start');
    });
  }

  // ----- footer: call to action, the short link, the QR code -----
  const footTop = 1128;
  ctx.fillStyle = alpha(pal.mint, 0.35);
  ctx.fillRect(M, footTop - 14, innerW, 2);

  const plate = 196;
  const plateY = footTop + 6;
  const plateOffsetFromEnd = M;
  const plateX = rtl ? plateOffsetFromEnd : W - plateOffsetFromEnd - plate;
  roundRect(ctx, plateX, plateY, plate, plate, 24);
  ctx.fillStyle = pal.offwhite;
  ctx.fill();
  const n = qr.size;
  const mod = Math.floor((plate - 28) / n);
  const qrSide = mod * n;
  const qx = plateX + (plate - qrSide) / 2;
  const qy = plateY + (plate - qrSide) / 2;
  ctx.fillStyle = pal.purple;
  for (let r = 0; r < n; r++) {
    const line = qr.data[r];
    if (!line) continue;
    for (let col = 0; col < n; col++) if (line[col]) ctx.fillRect(qx + col * mod, qy + r * mod, mod, mod);
  }

  const copyMax = innerW - plate - 36;
  if (data.vote) {
    // A button-looking call to action next to the QR code.
    const btnH = 96;
    const btnY = plateY + 18;
    const btnX = boxX(M, copyMax);
    roundRect(ctx, btnX, btnY, copyMax, btnH, btnH / 2);
    ctx.fillStyle = pal.mint;
    ctx.fill();
    ctx.fillStyle = pal.purple;
    ctx.font = font(800, 38);
    text(fit(ctx, data.ctaText, copyMax - 48), btnX + copyMax / 2, btnY + btnH / 2 + 14, 'center');
  } else {
    ctx.fillStyle = pal.offwhite;
    ctx.font = font(800, 44);
    // The call to action wraps onto two lines when it is too long for the space next to the QR code.
    const words = data.ctaText.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width <= copyMax || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    const shownLines = lines.slice(0, 2);
    let fy = plateY + 56;
    for (const l of shownLines) {
      text(fit(ctx, l, copyMax), sx(M), fy, 'start');
      fy += 56;
    }
  }
  ctx.fillStyle = pal.mint;
  ctx.font = font(600, 28);
  // The address is Latin: a left-to-right run, aligned to the start edge like the text above.
  ctx.direction = 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  ctx.fillText(fit(ctx, data.shortUrl, copyMax), sx(M), plateY + plate - 8);

  return new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
  });
}
