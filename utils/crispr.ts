
import { Cas9Site, RepairResult, CodonTable, AlignmentData } from '../types';

// --- Constants & Tables ---

export const CODON_TABLE: CodonTable = {
  'F': ['TTT', 'TTC'], 'L': ['TTA', 'TTG', 'CTT', 'CTC', 'CTA', 'CTG'],
  'I': ['ATT', 'ATC', 'ATA'], 'M': ['ATG'], 'V': ['GTT', 'GTC', 'GTA', 'GTG'],
  'S': ['TCT', 'TCC', 'TCA', 'TCG', 'AGT', 'AGC'], 'P': ['CCT', 'CCC', 'CCA', 'CCG'],
  'T': ['ACT', 'ACC', 'ACA', 'ACG'], 'A': ['GCT', 'GCC', 'GCA', 'GCG'],
  'Y': ['TAT', 'TAC'], 'H': ['CAT', 'CAC'], 'Q': ['CAA', 'CAG'],
  'N': ['AAT', 'AAC'], 'K': ['AAA', 'AAG'], 'D': ['GAT', 'GAC'],
  'E': ['GAA', 'GAG'], 'C': ['TGT', 'TGC'], 'W': ['TGG'],
  'R': ['CGT', 'CGC', 'CGA', 'CGG', 'AGA', 'AGG'], 'G': ['GGT', 'GGC', 'GGA', 'GGG'],
  '*': ['TAA', 'TAG', 'TGA'],
};

// Invert the map for codon -> AA lookup
export const AA_LOOKUP: { [codon: string]: string } = {};
Object.entries(CODON_TABLE).forEach(([aa, codons]) => {
  codons.forEach(codon => {
    AA_LOOKUP[codon] = aa;
  });
});

// --- Scoring Logic (Doench 2014 Rule Set 1 Simplified) ---
// Returns a score 0-100 based on the 30mer context (4bp + 20bp spacer + PAM + 3bp)
// Reference: Doench JG, et al. Nat Biotechnol. 2014.
function calculateScore(context30: string): number {
  if (!context30 || context30.length !== 30) return 0;
  
  const seq = context30.toUpperCase();
  let score = 0.5976;
  const gcCount = (seq.slice(4, 24).match(/[GC]/g) || []).length;
  const gcHigh = gcCount > 10 ? -0.1664 : 0; // High GC penalty
  const gcLow = gcCount < 10 ? -0.2026 : 0;  // Low GC penalty
  score += gcHigh + gcLow;

  // Position-specific weights (Simplified/Selected top features)
  // Index 0-3: 5' flank, 4-23: Guide, 24-26: PAM, 27-29: 3' flank
  // Focusing on critical seed region preferences
  const weights: Record<string, number> = {
    'G2': -0.2753, 'A3': -0.3238, 'C3': 0.1721, 'C6': -0.1006, 'C15': -0.2017,
    'C16': -0.0954, 'C18': -0.1852, 'G20': -0.1045, 'G21': -0.1604, 'A21': 0.0841,
    'G23': 0.1324, 'C24': 0.0894, // PAM proximal
    'A24': 0.0766, 'T28': 0.0396, 'C28': 0.1298
  };

  // Check specific positions relative to PAM (PAM is at 25-27 in standard numbering, here 24-26 0-indexed)
  // Indices here are relative to the 30bp string
  // Guide is 4 to 23.
  const check = (nuc: string, pos: number, weight: number) => {
      if (seq[pos] === nuc) score += weight;
  };
  
  // Apply a subset of high-impact weights for simulation
  check('G', 4+1, -0.27); // G2 (Pos 2 in guide, index 5 in context)
  check('T', 29, -0.10);  // T at 3' end
  check('C', 20, 0.10);   // C in seed
  check('G', 23, -0.15);  // G before PAM

  // Normalize roughly to 0-100
  // Since this is a log-odds based score originally, we map it sigmoidally
  const probability = 1 / (1 + Math.exp(-score * 4)); // Sigmoid scaling
  return Math.round(probability * 100);
}

// --- Utils ---

export function reverseComplement(seq: string): string {
  const complement: { [key: string]: string } = {
    'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C',
    'a': 't', 't': 'a', 'c': 'g', 'g': 'c',
    'N': 'N', 'n': 'n', '-': '-'
  };
  return seq.split('').reverse().map(base => complement[base] || base).join('');
}

export function translate(seq: string): string {
  let protein = "";
  const cleanSeq = seq.toUpperCase();
  for (let i = 0; i < cleanSeq.length; i += 3) {
    if (i + 3 > cleanSeq.length) break;
    const codon = cleanSeq.substring(i, i + 3);
    protein += AA_LOOKUP[codon] || "X";
  }
  return protein;
}

export function codonToAA(codon: string): string | null {
  return AA_LOOKUP[codon.toUpperCase()] || null;
}

export function generateSimpleAlignment(seq1: string, seq2: string): string {
  let match = "";
  const len = Math.max(seq1.length, seq2.length);
  for (let i = 0; i < len; i++) {
    const c1 = seq1[i] || '-';
    const c2 = seq2[i] || '-';
    if (c1 === c2 && c1 !== '-' && c2 !== '-') {
      match += "|";
    } else {
      match += " ";
    }
  }
  return match;
}

// --- Cas9 Logic ---

const WINDOW = 105;

export function findCas9Sites(geneSequence: string, aminoAcidPosition: number): Cas9Site[] {
  const nucleotidePosition = (aminoAcidPosition - 1) * 3;
  const start = Math.max(0, nucleotidePosition - Math.floor(WINDOW / 2));
  const end = Math.min(geneSequence.length, nucleotidePosition + Math.floor(WINDOW / 2));
  const region = geneSequence.substring(start, end);

  const sites: Cas9Site[] = [];

  // Forward: N(20)NGG
  // We grab a bit more context for scoring: 4bp before + 20bp + 3bp PAM + 3bp after = 30bp
  const forwardRegex = /(?=([ACGT]{20}[ACGT]GG))/gi;
  let match;
  while ((match = forwardRegex.exec(region)) !== null) {
    const siteStart = start + match.index;
    
    // Attempt to grab 30bp context
    // Index relative to 'start' of region: match.index
    // Guide starts at match.index
    // We want match.index - 4 to match.index + 23 + 3
    const contextStart = match.index - 4;
    let context30 = "";
    if (contextStart >= 0 && contextStart + 30 <= region.length) {
        context30 = region.substring(contextStart, contextStart + 30);
    }

    sites.push({
      position: siteStart,
      sequence: match[1],
      strand: 'forward',
      context30
    });
    forwardRegex.lastIndex = match.index + 1;
  }

  // Reverse: CC N(20)
  const reverseRegex = /(?=(CC[ACGT][ACGT]{20}))/gi;
  while ((match = reverseRegex.exec(region)) !== null) {
    const siteStart = start + match.index;
    
    // For reverse strand, we need to extract the forward equivalent of the 30bp context to score it?
    // Usually scoring models work on the 5'->3' of the guide itself.
    // For CC N(20), the guide is the reverse complement of N(20). 
    // The "Sequence" on Forward strand is match[1]. 
    // The actual guide RNA is RevComp(N(20)). 
    // For simplicity in this demo, we extract the 30bp on the reverse complement of the region if possible, 
    // OR we just use a placeholder if context extraction is complex on reverse without full gene bounds.
    
    // We'll skip score context for reverse in this simplified version unless we map coords carefully
    sites.push({
      position: siteStart,
      sequence: match[1],
      strand: 'reverse'
    });
    reverseRegex.lastIndex = match.index + 1;
  }

  // Sort by distance to mutation site
  return sites.sort((a, b) => {
    return Math.abs(a.position - nucleotidePosition) - Math.abs(b.position - nucleotidePosition);
  });
}

interface MutationAttempt {
    sequence: string[];
    mutated: boolean;
    strategy: 'PAM_SILENT' | 'SEED_SILENT' | null;
    mutationCount: number;
}

function mutatePam(
  homologyList: string[],
  strand: 'forward' | 'reverse',
  pamStart: number,
  homologyStart: number
): MutationAttempt {
  const pamPosInHomology = pamStart - homologyStart;
  const listCopy = [...homologyList];

  const criticalIndices = strand === 'forward'
    ? [pamPosInHomology + 21, pamPosInHomology + 22]
    : [pamPosInHomology, pamPosInHomology + 1];

  const codonStarts = new Set<number>();
  criticalIndices.forEach(idx => {
    if (idx >= 0 && idx < listCopy.length) {
      codonStarts.add(Math.floor(idx / 3) * 3);
    }
  });

  const sortedCodonStarts = Array.from(codonStarts).sort((a, b) => a - b);

  let bestResult: MutationAttempt = { sequence: [], mutated: false, strategy: null, mutationCount: 0 };
  let minChanges = Infinity;

  for (const codonStart of sortedCodonStarts) {
    if (codonStart + 3 > listCopy.length) continue;

    const currentCodon = listCopy.slice(codonStart, codonStart + 3).join('').toUpperCase();
    const currentAA = codonToAA(currentCodon);
    if (!currentAA || currentAA === '*') continue;

    const synonymousCodons = CODON_TABLE[currentAA] || [];

    for (const synonym of synonymousCodons) {
      if (synonym === currentCodon) continue;
      if (codonToAA(synonym) !== currentAA) continue;

      let disrupts = false;
      let tempChanges = 0;

      for (let i = 0; i < 3; i++) {
        const pos = codonStart + i;
        if (criticalIndices.includes(pos)) {
            if (synonym[i] !== currentCodon[i]) {
                disrupts = true;
            }
        }
        if (synonym[i] !== currentCodon[i]) tempChanges++;
      }

      if (disrupts) {
        if (tempChanges < minChanges) {
             minChanges = tempChanges;
             const newList = [...homologyList];
             for (let i = 0; i < 3; i++) newList[codonStart + i] = synonym[i];
             bestResult = { sequence: newList, mutated: true, strategy: 'PAM_SILENT', mutationCount: tempChanges };
        }
      }
    }
  }

  return bestResult;
}

function mutateSeed(
  homologyList: string[],
  strand: 'forward' | 'reverse',
  pamStart: number,
  homologyStart: number
): MutationAttempt {
    const pamPosInHomology = pamStart - homologyStart;
    const listCopy = [...homologyList];
    
    const seedIndices = new Set<number>();
    if (strand === 'forward') {
        for(let i=10; i<=19; i++) seedIndices.add(pamPosInHomology + i);
    } else {
        for(let i=3; i<=12; i++) seedIndices.add(pamPosInHomology + i);
    }

    const codonStarts = new Set<number>();
    seedIndices.forEach(idx => {
         if(idx >= 0 && idx < listCopy.length) {
            codonStarts.add(Math.floor(idx/3)*3);
        }
    });

    const sortedCodonStarts = Array.from(codonStarts).sort((a,b)=>a-b);
    let totalMutations = 0;

    for (const codonStart of sortedCodonStarts) {
         if (codonStart + 3 > listCopy.length) continue;
         
         const currentCodon = listCopy.slice(codonStart, codonStart+3).join('').toUpperCase();
         const currentAA = codonToAA(currentCodon);
         if (!currentAA || currentAA === '*') continue;
         
         const synonyms = CODON_TABLE[currentAA] || [];
         
         let bestSynonym = null;
         let maxNewSeedChanges = 0;
         let bestTotalChanges = 0;

         for (const synonym of synonyms) {
             if (synonym === currentCodon) continue;
             if (codonToAA(synonym) !== currentAA) continue;

             let seedChanges = 0;
             let totalChanges = 0;
             for(let i=0; i<3; i++) {
                 if (synonym[i] !== currentCodon[i]) {
                     totalChanges++;
                     if (seedIndices.has(codonStart + i)) {
                         seedChanges++;
                     }
                 }
             }
             
             if (seedChanges > maxNewSeedChanges) {
                 maxNewSeedChanges = seedChanges;
                 bestTotalChanges = totalChanges;
                 bestSynonym = synonym;
             }
         }
         
         if (bestSynonym && maxNewSeedChanges > 0) {
             for(let i=0; i<3; i++) listCopy[codonStart+i] = bestSynonym[i];
             totalMutations += bestTotalChanges; 
         }
         
         if (totalMutations >= 2) break;
    }

    if (totalMutations >= 2) {
        return { sequence: listCopy, mutated: true, strategy: 'SEED_SILENT', mutationCount: totalMutations };
    }

    return { sequence: [], mutated: false, strategy: null, mutationCount: 0 };
}

export function generateRepairTemplates(
  geneSequence: string,
  cas9Sites: Cas9Site[],
  aminoAcidPosition: number,
  newAminoAcid: string,
  templateSize: number = 75
): RepairResult[] {
  const results: RepairResult[] = [];
  const mutationPosition = (aminoAcidPosition - 1) * 3;

  for (const site of cas9Sites) {
    const cas9CutPosition = site.position + 17;
    const pamStart = site.position;

    // Use fixed template size centered between cut and mutation
    const center = Math.floor((cas9CutPosition + mutationPosition) / 2);
    const halfSize = Math.floor(templateSize / 2);
    
    // Ensure 0-bound and gene-length bound
    const homologyStart = Math.max(0, center - halfSize);
    const homologyEnd = Math.min(geneSequence.length, center + halfSize + (templateSize % 2));

    const originalHomologyRegion = geneSequence.substring(homologyStart, homologyEnd);
    const homologyList = originalHomologyRegion.split('');

    // --- Deletion Control Generation (Remove PAM) ---
    // PAM indices in homology region
    const pamPosInHomology = pamStart - homologyStart;
    const deletionIndices = site.strand === 'forward'
        ? [pamPosInHomology + 21, pamPosInHomology + 22] // The 'GG' of NGG
        : [pamPosInHomology, pamPosInHomology + 1];      // The 'CC' of CCN
    
    // Construct deletion strings
    const deletionList = homologyList.filter((_, idx) => !deletionIndices.includes(idx));
    const deletionRepairTemplate = deletionList.join('');
    
    // Construct display string (with dashes)
    const deletionDnaDisplay = homologyList.map((char, idx) => deletionIndices.includes(idx) ? '-' : char).join('');

    // --- Deletion Protein Translation ---
    // Get larger context, simulate deletion, translate
    const contextFlank = 150;
    const alignStart = Math.max(0, mutationPosition - contextFlank);
    const alignEnd = Math.min(geneSequence.length, mutationPosition + 3 + contextFlank);
    const originalLargeDna = geneSequence.substring(alignStart, alignEnd);
    const deletionLargeList = originalLargeDna.split('');
    const pamStartInLarge = pamStart - alignStart;
    
    // Remove PAM in large context
    const delIndicesLarge = site.strand === 'forward'
        ? [pamStartInLarge + 21, pamStartInLarge + 22]
        : [pamStartInLarge, pamStartInLarge + 1];

    const mutatedLargeList = deletionLargeList.filter((_, idx) => !delIndicesLarge.includes(idx));
    const deletionLargeDna = mutatedLargeList.join('');
    
    // Correctly calculate frame to align with start of next codon relative to alignStart
    const frame = (3 - (alignStart % 3)) % 3;
    const deletionProtein = translate(deletionLargeDna.substring(frame));


    // --- Desired Mutation Logic (Point Mutation) ---
    // 1. Apply Desired Mutation (Target AA)
    const codonStartInHomology = mutationPosition - homologyStart;
    if (codonStartInHomology >= 0 && codonStartInHomology < homologyList.length) {
      const originalCodon = homologyList.slice(codonStartInHomology, codonStartInHomology + 3).join('').toUpperCase();
      const newCodonOptions = CODON_TABLE[newAminoAcid.toUpperCase()];

      if (!newCodonOptions || newCodonOptions.length === 0) continue; 

      let newCodon = newCodonOptions[0];
      for (const opt of newCodonOptions) {
        if (opt !== originalCodon) {
          newCodon = opt;
          break;
        }
      }

      for (let i = 0; i < 3; i++) {
        homologyList[codonStartInHomology + i] = newCodon[i];
      }
    }

    let finalHomologyList = [...homologyList];
    let strategy: RepairResult['strategy'] | null = null;
    let silentMutationCount = 0;

    // 2. Check if Target Mutation disrupted PAM already
    const criticalIndices = site.strand === 'forward'
        ? [pamPosInHomology + 21, pamPosInHomology + 22]
        : [pamPosInHomology, pamPosInHomology + 1];
    
    let pamAlreadyDisrupted = false;
    for(const idx of criticalIndices) {
        if (idx >= 0 && idx < homologyList.length) {
            if (homologyList[idx].toUpperCase() !== originalHomologyRegion[idx].toUpperCase()) {
                pamAlreadyDisrupted = true;
                break;
            }
        }
    }

    if (pamAlreadyDisrupted) {
        strategy = 'PAM_DISRUPTED_BY_TARGET';
        silentMutationCount = 0;
    } else {
        // 3. Try Silent PAM Mutation
        const pamAttempt = mutatePam(homologyList, site.strand, pamStart, homologyStart);
        if (pamAttempt.mutated && pamAttempt.strategy) {
            finalHomologyList = pamAttempt.sequence;
            strategy = pamAttempt.strategy;
            silentMutationCount = pamAttempt.mutationCount;
        } else {
            // 4. Try Silent Seed Mutation (Fallback)
            const seedAttempt = mutateSeed(homologyList, site.strand, pamStart, homologyStart);
            if (seedAttempt.mutated && seedAttempt.strategy) {
                finalHomologyList = seedAttempt.sequence;
                strategy = seedAttempt.strategy;
                silentMutationCount = seedAttempt.mutationCount;
            }
        }
    }

    if (!strategy) continue;

    // 5. Format Case
    const finalCasedList: string[] = [];
    for (let i = 0; i < finalHomologyList.length; i++) {
      const finalChar = finalHomologyList[i];
      const originalChar = originalHomologyRegion[i];
      if (finalChar.toUpperCase() !== originalChar.toUpperCase()) {
        finalCasedList.push(finalChar.toLowerCase());
      } else {
        finalCasedList.push(finalChar.toUpperCase());
      }
    }
    const mutatedHomology = finalCasedList.join('');

    // 6. Generate Oligos
    const sgRNASeqWithPam = site.strand === 'reverse'
      ? reverseComplement(site.sequence)
      : site.sequence;
    const guideSeq20nt = sgRNASeqWithPam.substring(0, 20).toUpperCase(); 
    
    const cloningOligoA = `gatc${guideSeq20nt}gttttagagctag`;
    const cloningOligoB = `ctagctctaaaac${reverseComplement(guideSeq20nt).toUpperCase()}`;

    // 7. Verification
    const repairedLargeList = originalLargeDna.split('');
    const tempStartInLarge = homologyStart - alignStart;

    for (let i = 0; i < mutatedHomology.length; i++) {
        if (tempStartInLarge + i >= 0 && tempStartInLarge + i < repairedLargeList.length) {
            repairedLargeList[tempStartInLarge + i] = mutatedHomology[i];
        }
    }
    const repairedLargeDna = repairedLargeList.join('');
    const originalLargeAA = translate(originalLargeDna.substring(frame));
    const repairedLargeAA = translate(repairedLargeDna.substring(frame));

    let aaDiffCount = 0;
    const len = Math.min(originalLargeAA.length, repairedLargeAA.length);
    for(let k=0; k<len; k++) {
        if (originalLargeAA[k] !== repairedLargeAA[k]) aaDiffCount++;
    }

    if (aaDiffCount !== 1) continue;

    // Calculate Score
    const score = site.context30 ? calculateScore(site.context30) : undefined;

    results.push({
      site,
      cloningOligoA,
      cloningOligoB,
      repairTemplate: mutatedHomology,
      guideSeqWithPam: sgRNASeqWithPam, // Populate new field
      score, // Populate score
      
      deletionRepairTemplate,
      deletionDnaDisplay,
      deletionProtein,

      originalRegion: originalHomologyRegion,
      homologyStart,
      mutationPosition,
      aaChangeStatus: 'success',
      aaChangesCount: aaDiffCount,
      dnaAlignment: {
          original: originalHomologyRegion.toUpperCase(),
          modified: mutatedHomology.toUpperCase(),
          matchString: generateSimpleAlignment(originalHomologyRegion.toUpperCase(), mutatedHomology.toUpperCase())
      },
      aaAlignment: {
          original: originalLargeAA,
          modified: repairedLargeAA,
          matchString: generateSimpleAlignment(originalLargeAA, repairedLargeAA)
      },
      strategy: strategy,
      silentMutationCount: silentMutationCount
    });
  }

  // Sort results by Score if available
  results.sort((a, b) => (b.score || 0) - (a.score || 0));

  return results.slice(0, 5);
}
