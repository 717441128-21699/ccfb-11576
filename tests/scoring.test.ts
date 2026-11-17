import { describe, it, expect } from 'vitest';
import { scoreBoard, impDifference, matchpoints, crossImps, teamImp, rankByTotal } from '../src/engine/scoring.ts';
import { parseContract, standardVulnerability } from '../src/engine/tournament.ts';

describe('定约分', () => {
  it('1NT 做成 2 (超一) 无局 = 120', () => {
    expect(scoreBoard({ contract: parseContract('1NT', 0)!, tricks: 8, vulnerability: 0 })).toBe(120);
  });

  it('1NT 刚好 7 墩 无局 = 90', () => {
    expect(scoreBoard({ contract: parseContract('1NT', 0)!, tricks: 7, vulnerability: 0 })).toBe(90);
  });

  it('4S 刚好做成 无局 = 420', () => {
    expect(scoreBoard({ contract: parseContract('4S', 2)!, tricks: 10, vulnerability: 0 })).toBe(420);
  });

  it('4S 刚好做成 有局 = 620', () => {
    expect(scoreBoard({ contract: parseContract('4S', 2)!, tricks: 10, vulnerability: 1 })).toBe(620);
  });

  it('3NT 做成 无局 = 400, 有局 = 600', () => {
    expect(scoreBoard({ contract: parseContract('3NT', 0)!, tricks: 9, vulnerability: 0 })).toBe(400);
    expect(scoreBoard({ contract: parseContract('3NT', 0)!, tricks: 9, vulnerability: 1 })).toBe(600);
  });

  it('5C 做成 无局 = 400, 有局 = 600', () => {
    expect(scoreBoard({ contract: parseContract('5C', 1)!, tricks: 11, vulnerability: 0 })).toBe(400);
    expect(scoreBoard({ contract: parseContract('5C', 1)!, tricks: 11, vulnerability: 1 })).toBe(600);
  });

  it('小满贯/大满贯奖分', () => {
    expect(scoreBoard({ contract: parseContract('6H', 0)!, tricks: 12, vulnerability: 0 })).toBe(980);
    expect(scoreBoard({ contract: parseContract('6H', 0)!, tricks: 12, vulnerability: 1 })).toBe(1430);
    expect(scoreBoard({ contract: parseContract('7NT', 0)!, tricks: 13, vulnerability: 1 })).toBe(2220);
  });

  it('宕墩罚分', () => {
    // 4S 宕一 无局 -50 / 有局 -100
    expect(scoreBoard({ contract: parseContract('4S', 0)!, tricks: 9, vulnerability: 0 })).toBe(-50);
    expect(scoreBoard({ contract: parseContract('4S', 0)!, tricks: 9, vulnerability: 1 })).toBe(-100);
    // 加倍宕一 无局 -100 / 有局 -200
    expect(scoreBoard({ contract: parseContract('4Sx', 0)!, tricks: 9, vulnerability: 0 })).toBe(-100);
    expect(scoreBoard({ contract: parseContract('4Sx', 0)!, tricks: 9, vulnerability: 1 })).toBe(-200);
    // 加倍宕三 无局: 100+200+200 = 500
    expect(scoreBoard({ contract: parseContract('4Sx', 0)!, tricks: 7, vulnerability: 0 })).toBe(-500);
    // 再加倍宕一 有局 -400
    expect(scoreBoard({ contract: parseContract('4Sxx', 0)!, tricks: 9, vulnerability: 1 })).toBe(-400);
  });

  it('加倍做成但未成局: 定约翻倍 + 不成局奖 + 50 insult', () => {
    // 1Sx 做成 (7墩) 无局: 定约分 30*2=60 (<100 不成局) + 50 + 50 = 160
    expect(scoreBoard({ contract: parseContract('1Sx', 0)!, tricks: 7, vulnerability: 0 })).toBe(160);
  });

  it('加倍后达到成局线: 2Sx 做成 = 120 定约分 + 成局奖', () => {
    // 2Sx 刚好 8 墩 无局: 60*2=120 (成局) + 300 + 50 = 470
    expect(scoreBoard({ contract: parseContract('2Sx', 0)!, tricks: 8, vulnerability: 0 })).toBe(470);
    // 有局: 120 + 500 + 50 = 670
    expect(scoreBoard({ contract: parseContract('2Sx', 0)!, tricks: 8, vulnerability: 1 })).toBe(670);
  });

  it('加倍超墩', () => {
    // 2Sx 超一 (9墩) 无局: 定约分 60*2=120 + 不成局? 120>=100 成局 300 + 50 + 超墩100 = 570
    expect(scoreBoard({ contract: parseContract('2Sx', 0)!, tricks: 9, vulnerability: 0 })).toBe(570);
    // 有局超墩 200: 120 + 500 + 50 + 200 = 870
    expect(scoreBoard({ contract: parseContract('2Sx', 0)!, tricks: 9, vulnerability: 1 })).toBe(870);
  });

  it('全 pass = 0', () => {
    expect(scoreBoard({ contract: null, tricks: 0, vulnerability: 0 })).toBe(0);
  });
});

describe('IMP 换算', () => {
  it('边界点', () => {
    expect(impDifference(0)).toBe(0);
    expect(impDifference(10)).toBe(0);
    expect(impDifference(20)).toBe(1);
    expect(impDifference(150)).toBe(4); // 130-160
    expect(impDifference(430)).toBe(10); // 430-490
    expect(impDifference(750)).toBe(13); // 750-890
    expect(impDifference(-430)).toBe(10);
    expect(impDifference(4000)).toBe(24); // 最大档
    expect(impDifference(9999)).toBe(24);
  });
});

describe('比赛分 / 交叉 IMP / 队式', () => {
  it('比赛分: 4 桌排序', () => {
    expect(matchpoints([100, 400, 400, -50])).toEqual([1, 2.5, 2.5, 0]);
  });

  it('交叉 IMP: 直接验证两两差值', () => {
    // 三个得分 100, 400, -50:
    //   r[0] = IMP(100-400)+IMP(100-(-50)) = -IMP(300)+IMP(150) = -7+4 = -3
    //   r[1] = IMP(300)+IMP(450)           = 7+10 = 17
    //   r[2] = -IMP(150)-IMP(450)          = -4-10 = -14
    const r = crossImps([100, 400, -50]);
    expect(r).toEqual([-3, 17, -14]);
    // 对称输入下总和为 0
    const sym = crossImps([100, -100]);
    expect(sym[0]! + sym[1]!).toBe(0);
  });

  it('队式 IMP', () => {
    expect(teamImp(420, -50)).toBe(impDifference(470));
  });

  it('排名并列', () => {
    const r = rankByTotal([
      { id: 'a', total: 10 },
      { id: 'b', total: 20 },
      { id: 'c', total: 20 },
      { id: 'd', total: 5 },
    ]);
    expect(r.map((x) => [x.id, x.rank])).toEqual([
      ['b', 1],
      ['c', 1],
      ['a', 3],
      ['d', 4],
    ]);
  });
});

describe('标准局况轮转', () => {
  it('前 4 副', () => {
    expect(standardVulnerability(1)).toMatchObject({ dealer: 0, vulnNS: 0, vulnEW: 0 });
    expect(standardVulnerability(2)).toMatchObject({ dealer: 1, vulnNS: 1, vulnEW: 0 });
    expect(standardVulnerability(3)).toMatchObject({ dealer: 2, vulnNS: 0, vulnEW: 1 });
    expect(standardVulnerability(4)).toMatchObject({ dealer: 3, vulnNS: 1, vulnEW: 1 });
  });
});
