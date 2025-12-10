

// Simple scoring matrix for proteins (BLOSUM62-ish simplified)
const MATCH_SCORE = 5;
const MISMATCH_SCORE = -4;
const GAP_OPEN = -10;
const GAP_EXTEND = -1;

const AA_GROUPS = [
  new Set("VLIM"), new Set("FYW"), new Set("MILF"), new Set("MILV"), new Set("KRH"), new Set("DE"), 
  new Set("ST"), new Set("NQ"), new Set("HY"), new Set("NDEQ"), new Set("SGND"), new Set("STPA"), 
  new Set("STNK"), new Set("NEQK"), new Set("NHQK"), new Set("QHRK"), new Set("HFY"), new Set("FVLIM"), 
  new Set("CSA"), new Set("ATV"), new Set("SAG"), new Set("SNDEQK"), new Set("NDEQHK"), new Set("NEQHRK")
];

export const AA_MAP_3_TO_1: Record<string, string> = {
  'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C',
  'Gln': 'Q', 'Glu': 'E', 'Gly': 'G', 'His': 'H', 'Ile': 'I',
  'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F', 'Pro': 'P',
  'Ser': 'S', 'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V',
  'Ter': '*'
};

// Inverse map
export const AA_MAP_1_TO_3: Record<string, string> = Object.entries(AA_MAP_3_TO_1).reduce((acc, [k, v]) => {
  acc[v] = k;
  return acc;
}, {} as Record<string, string>);

export const isSimilarAA = (aa1: string, aa2: string): boolean => {
  if (aa1 === aa2) return true;
  for (const group of AA_GROUPS) {
    if (group.has(aa1) && group.has(aa2)) return true;
  }
  return false;
};

// Simplified Needleman-Wunsch
export const alignSequences = (seq1: string, seq2: string): { aligned1: string, aligned2: string } => {
  const n = seq1.length;
  const m = seq2.length;
  
  if (n * m > 2500 * 2500) {
     console.warn("Sequences too long for client-side optimal alignment.");
  }

  const score = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  const ptr = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) score[i][0] = GAP_OPEN + (i-1) * GAP_EXTEND;
  for (let j = 1; j <= m; j++) score[0][j] = GAP_OPEN + (j-1) * GAP_EXTEND;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const char1 = seq1[i - 1];
      const char2 = seq2[j - 1];
      const similarity = isSimilarAA(char1, char2) ? 2 : MISMATCH_SCORE; 
      const matchSub = score[i - 1][j - 1] + (char1 === char2 ? MATCH_SCORE : similarity);
      
      const gapUp = score[i - 1][j] + GAP_EXTEND;
      const gapLeft = score[i][j - 1] + GAP_EXTEND;

      const maxScore = Math.max(matchSub, gapUp, gapLeft);
      score[i][j] = maxScore;

      if (maxScore === matchSub) ptr[i][j] = 1;
      else if (maxScore === gapUp) ptr[i][j] = 2;
      else ptr[i][j] = 3;
    }
  }

  let align1 = "";
  let align2 = "";
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ptr[i][j] === 1) {
      align1 = seq1[i - 1] + align1;
      align2 = seq2[j - 1] + align2;
      i--; j--;
    } else if (i > 0 && (j === 0 || ptr[i][j] === 2)) {
      align1 = seq1[i - 1] + align1;
      align2 = "-" + align2;
      i--;
    } else {
      align1 = "-" + align1;
      align2 = seq2[j - 1] + align2;
      j--;
    }
  }

  return { aligned1: align1, aligned2: align2 };
};

export const parseInputVariant = (input: string): { ref: string, res: number, target: string } | null => {
  // Remove p. prefix and whitespace
  const clean = input.trim().replace(/^p\./i, '');

  // Case 1: 3-letter code (e.g. Arg114Gln, arg114gln, ARG114GLN)
  const threeLetterRegex = /^([A-Z]{3})\s*(\d+)\s*([A-Z]{3})$/i;
  const match3 = clean.match(threeLetterRegex);
  if (match3) {
    // Normalize case: "arg" -> "Arg"
    const refKey = match3[1].charAt(0).toUpperCase() + match3[1].slice(1).toLowerCase();
    const targetKey = match3[3].charAt(0).toUpperCase() + match3[3].slice(1).toLowerCase();

    const refAA = AA_MAP_3_TO_1[refKey];
    const targetAA = AA_MAP_3_TO_1[targetKey];

    if (refAA && targetAA) {
      return {
        ref: refAA,
        res: parseInt(match3[2]),
        target: targetAA
      };
    }
  }

  // Case 2: 1-letter code (e.g. R114Q, r114q)
  const oneLetterRegex = /^([A-Z])\s*(\d+)\s*([A-Z])$/i;
  const match1 = clean.match(oneLetterRegex);
  if (match1) {
    return {
      ref: match1[1].toUpperCase(),
      res: parseInt(match1[2]),
      target: match1[3].toUpperCase()
    };
  }

  return null;
};

export const AA_MAP = AA_MAP_3_TO_1;
export const parseProteinChange = parseInputVariant;
