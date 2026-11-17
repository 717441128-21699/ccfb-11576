interface Props {
  tsv: string;
  setTsv: (v: string) => void;
  onImport: () => void;
  onLoadSample: () => void;
  pbnInput: string;
  setPbnInput: (v: string) => void;
  onImportPbn: () => void;
  onAddRandom: () => void;
  entryCount: number;
  dealCount: number;
}

export function EntryForm(p: Props): JSX.Element {
  return (
    <div className="entry-form">
      <section className="card">
        <h2>比赛成绩录入</h2>
        <p className="hint">
          支持 TSV / CSV, 表头列: <code>board, table, ns, ew, contract, declarer, tricks</code>
          。定约如 <code>4Sx</code>、<code>3NT</code>、<code>6Hxx</code>、<code>pass</code>; 庄家填 N/E/S/W。
        </p>
        <textarea
          value={p.tsv}
          onChange={(e) => p.setTsv(e.target.value)}
          rows={12}
          placeholder={'board\ttable\tns\tew\tcontract\tdeclarer\ttricks\n1\tT1\tNS1\tEW1\t4S\tN\t10'}
        />
        <div className="button-row">
          <button className="primary" onClick={p.onImport}>
            导入并计分
          </button>
          <button onClick={p.onLoadSample}>载入示例数据 (8 副 × 4 桌)</button>
        </div>
        <p className="status">
          当前已录入 <strong>{p.entryCount}</strong> 条成绩, <strong>{p.dealCount}</strong> 副发牌。
        </p>
      </section>

      <section className="card">
        <h2>发牌数据 (PBN, 可选)</h2>
        <p className="hint">
          每行一副 PBN 发牌串 (如 <code>N:AK... . ...</code>), 可前缀 <code>牌号 发牌串</code>。
          只有提供发牌才能做双明手复盘。
        </p>
        <textarea
          value={p.pbnInput}
          onChange={(e) => p.setPbnInput(e.target.value)}
          rows={6}
          placeholder="N:63.AKQ987.A972. 2 ..."
        />
        <div className="button-row">
          <button onClick={p.onImportPbn}>导入发牌</button>
          <button onClick={p.onAddRandom}>随机生成一副</button>
        </div>
      </section>
    </div>
  );
}
