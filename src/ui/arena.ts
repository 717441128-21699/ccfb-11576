/**
 * 对局画布渲染：把整数网格世界（千分之一像素）缩放到 Canvas 像素，
 * 画两个客户端的插值视图、角色碰撞箱与攻击命中盒。
 */

import { ARENA_H, ARENA_W, GROUND_Y } from '../core/simulation';
import type { WorldState } from '../core/types';

const P0_COLOR = '#58a6ff';
const P1_COLOR = '#f778ba';
const HITBOX_COLOR = '#f0b429';

export class ArenaRenderer {
  private ctx: CanvasRenderingContext2D;
  /** 网格单位 -> CSS 像素 的缩放 */
  private scale = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  draw(state: WorldState, title: string, highlight: 0 | 1 | null): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 620;
    const cssH = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(cssW * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    this.scale = Math.min(cssW / (ARENA_W / 1000), cssH / (ARENA_H / 1000));
    const ox = (cssW - (ARENA_W / 1000) * this.scale) / 2;
    const oy = (cssH - (ARENA_H / 1000) * this.scale) / 2;
    const px = (gx: number): number => ox + (gx / 1000) * this.scale;
    const py = (gy: number): number => oy + (gy / 1000) * this.scale;
    const ps = (g: number): number => (g / 1000) * this.scale;

    // 场地背景
    ctx.fillStyle = '#0d1420';
    ctx.fillRect(px(0), py(0), ps(ARENA_W), ps(ARENA_H));

    // 网格线（每 80 像素一条，直观看整数网格）
    ctx.strokeStyle = 'rgba(88,166,255,0.07)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= ARENA_W; gx += 80_000) {
      ctx.beginPath();
      ctx.moveTo(px(gx), py(0));
      ctx.lineTo(px(gx), py(ARENA_H));
      ctx.stroke();
    }

    // 地面
    ctx.fillStyle = '#21262d';
    ctx.fillRect(px(0), py(GROUND_Y), ps(ARENA_W), cssH - py(GROUND_Y));
    ctx.strokeStyle = '#3fb950';
    ctx.beginPath();
    ctx.moveTo(px(0), py(GROUND_Y));
    ctx.lineTo(px(ARENA_W), py(GROUND_Y));
    ctx.stroke();

    // 玩家
    for (let id = 0; id < 2; id++) {
      const p = state.players[id];
      const color = id === 0 ? P0_COLOR : P1_COLOR;
      const isHi = highlight === null || highlight === id;

      // 角色碰撞箱（实体矩形）
      ctx.globalAlpha = isHi ? 1 : 0.45;
      ctx.fillStyle = color + '33';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.rect(px(p.x), py(p.y), ps(p.w), ps(p.h));
      ctx.fill();
      ctx.stroke();

      // 朝向小三角
      ctx.fillStyle = color;
      const eyeX = px(p.x) + (p.facing === 1 ? ps(p.w) - 6 : 6);
      const eyeY = py(p.y) + 7;
      ctx.beginPath();
      ctx.arc(eyeX, eyeY, 2.4, 0, Math.PI * 2);
      ctx.fill();

      // 攻击命中盒
      if (p.hitbox.active === 1) {
        ctx.fillStyle = HITBOX_COLOR + '55';
        ctx.strokeStyle = HITBOX_COLOR;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.rect(px(p.hitbox.x), py(p.hitbox.y), ps(p.hitbox.w), ps(p.hitbox.h));
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 血条
      const barW = ps(p.w);
      const hpRatio = Math.max(0, p.hp) / 100;
      ctx.fillStyle = '#30363d';
      ctx.fillRect(px(p.x), py(p.y) - 9, barW, 4);
      ctx.fillStyle = hpRatio > 0.3 ? '#3fb950' : '#f85149';
      ctx.fillRect(px(p.x), py(p.y) - 9, barW * hpRatio, 4);

      // 受击硬直描边
      if (p.hurtTimer > 0) {
        ctx.strokeStyle = '#f85149';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.rect(px(p.x) - 1, py(p.y) - 1, ps(p.w) + 2, ps(p.h) + 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 标题与帧号
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px monospace';
    ctx.fillText(`${title} · frame ${state.frame}`, 8, 14);
  }
}
