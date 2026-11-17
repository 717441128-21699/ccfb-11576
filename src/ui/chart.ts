/**
 * 轻量 Canvas 折线图（零依赖）。画监视页的逐帧指标。
 */

export interface ChartSeries {
  label: string;
  color: string;
  points: number[];
}

export class LineChart {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  /**
   * @param series    数据序列（每条等长，索引即相对帧）
   * @param maxY      纵轴上限；不传则自适应数据最大值
   * @param unit      纵轴单位标注
   */
  draw(series: ChartSeries[], maxY?: number, unit = ''): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 160;
    if (canvas.width !== Math.round(cssW * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW;
    const H = cssH;
    ctx.clearRect(0, 0, W, H);

    const padL = 38;
    const padR = 8;
    const padT = 10;
    const padB = 16;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const dataMax = series.reduce(
      (m, s) => Math.max(m, s.points.length ? Math.max(...s.points) : 0),
      0,
    );
    const top = maxY ?? Math.max(1, dataMax);

    // 网格 + Y 轴刻度
    ctx.strokeStyle = '#1c2330';
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px monospace';
    ctx.lineWidth = 1;
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const y = padT + (plotH * i) / gridN;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      const val = Math.round(top * (1 - i / gridN));
      ctx.fillText(`${val}`, 4, y + 3);
    }

    const n = series.reduce((m, s) => Math.max(m, s.points.length), 0);
    if (n < 2) {
      ctx.fillStyle = '#8b949e';
      ctx.fillText('等待数据…', padL + 6, padT + plotH / 2);
      this.drawLegend(series, W, padT);
      return;
    }

    const xAt = (i: number): number => padL + (plotW * i) / (n - 1);
    const yAt = (v: number): number => padT + plotH * (1 - Math.min(v, top) / top);

    for (const s of series) {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      s.points.forEach((v, i) => {
        const x = xAt(i);
        const y = yAt(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // X 轴单位
    ctx.fillStyle = '#8b949e';
    ctx.fillText(`帧（每点 1 帧，共 ${n} 帧窗口）${unit ? ' · ' + unit : ''}`, padL, H - 4);
    this.drawLegend(series, W, padT);
  }

  private drawLegend(series: ChartSeries[], W: number, padT: number): void {
    const ctx = this.ctx;
    let x = W - 8;
    ctx.font = '10.5px system-ui';
    const items = [...series].reverse();
    for (const s of items) {
      const text = s.label;
      const tw = ctx.measureText(text).width;
      x -= tw + 16;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, padT - 4, 9, 9);
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(text, x + 13, padT + 4);
      x -= 8;
    }
  }
}
