import { useMemo, useState } from 'react';
import { Hands, parsePBNDeal, makeRng, dealRandomHands } from '../engine/cards.ts';
import { makeBoards, parseEntries, aggregatePairs, type TableEntry, type Board } from '../engine/tournament.ts';
import { EntryForm } from './EntryForm.tsx';
import { ScoreBoard } from './ScoreBoard.tsx';
import { DealReview } from './DealReview.tsx';
import { buildSampleData } from '../state/sampleData.ts';

type Tab = 'entry' | 'scores' | 'review';

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('entry');
  const [tsv, setTsv] = useState('');
  const [entries, setEntries] = useState<TableEntry[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [handsByBoard, setHandsByBoard] = useState<Map<number, Hands>>(new Map());
  const [pbnInput, setPbnInput] = useState('');
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'MP' | 'IMP'>('MP');

  const boardNumbers = useMemo(() => [...new Set(entries.map((e) => e.boardNumber))].sort((a, b) => a - b), [entries]);

  const loadSample = (): void => {
    const sample = buildSampleData();
    setTsv(sample.tsv);
    const rows = parseEntries(sample.tsv);
    const parsed = rows.map((r) => ({
      boardNumber: r.boardNumber,
      tableId: r.tableId,
      nsPairId: r.nsPairId,
      ewPairId: r.ewPairId,
      contract: r.contract,
      tricks: r.tricks,
    }));
    setEntries(parsed);
    const maxBoard = sample.boardCount;
    setBoards(makeBoards(maxBoard));
    const handsMap = new Map<number, Hands>();
    sample.pbnDeals.forEach((pbn, i) => {
      handsMap.set(i + 1, parsePBNDeal(pbn, 0));
    });
    setHandsByBoard(handsMap);
    setError('');
    setTab('scores');
  };

  const handleImport = (): void => {
    try {
      const rows = parseEntries(tsv);
      const parsed: TableEntry[] = rows.map((r) => ({
        boardNumber: r.boardNumber,
        tableId: r.tableId,
        nsPairId: r.nsPairId,
        ewPairId: r.ewPairId,
        contract: r.contract,
        tricks: r.tricks,
      }));
      setEntries(parsed);
      const maxBoard = Math.max(...parsed.map((r) => r.boardNumber));
      setBoards(makeBoards(maxBoard));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const importPbn = (): void => {
    try {
      const deals = pbnInput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const map = new Map(handsByBoard);
      deals.forEach((line, i) => {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (m) {
          map.set(Number(m[1]), parsePBNDeal(m[2]!, 0));
        } else {
          map.set(boardNumbers[i] ?? i + 1, parsePBNDeal(line, 0));
        }
      });
      setHandsByBoard(map);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addRandomDeal = (): void => {
    const rng = makeRng((Math.random() * 1e9) | 0);
    const nextBoard = boardNumbers.length > 0 ? Math.max(...boardNumbers) + 1 : 1;
    const map = new Map(handsByBoard);
    map.set(nextBoard, dealRandomHands(rng));
    setHandsByBoard(map);
  };

  const results = useMemo(() => {
    if (entries.length === 0 || boards.length === 0) return [];
    try {
      return aggregatePairs(boards, entries, method);
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, [entries, boards, method]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>桥牌复式赛 · 计分与双明手复盘</h1>
        <nav className="tabs">
          <button className={tab === 'entry' ? 'active' : ''} onClick={() => setTab('entry')}>
            录入 / 导入
          </button>
          <button className={tab === 'scores' ? 'active' : ''} onClick={() => setTab('scores')}>
            成绩榜
          </button>
          <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>
            双明手复盘
          </button>
        </nav>
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      <main className="content">
        {tab === 'entry' && (
          <EntryForm
            tsv={tsv}
            setTsv={setTsv}
            onImport={handleImport}
            onLoadSample={loadSample}
            pbnInput={pbnInput}
            setPbnInput={setPbnInput}
            onImportPbn={importPbn}
            onAddRandom={addRandomDeal}
            entryCount={entries.length}
            dealCount={handsByBoard.size}
          />
        )}

        {tab === 'scores' && (
          <ScoreBoard
            results={results}
            entries={entries}
            boards={boards}
            method={method}
            setMethod={setMethod}
          />
        )}

        {tab === 'review' && (
          <DealReview
            boardNumbers={boardNumbers}
            handsByBoard={handsByBoard}
            boards={boards}
          />
        )}
      </main>
    </div>
  );
}
