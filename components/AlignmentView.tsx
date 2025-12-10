

import React, { useMemo, useEffect, useRef } from 'react';
import { Variant } from '../types';
import { isSimilarAA } from '../utils/alignment';

interface Props {
  humanSeq: string;
  yeastSeq: string;
  variants: Variant[];
  humanName: string;
  yeastName: string;
  selectedResidue?: number | null;
}

export const AlignmentView: React.FC<Props> = ({ humanSeq, yeastSeq, variants, humanName, yeastName, selectedResidue }) => {
  const LINE_WIDTH = 60;
  const lastScrolledResidue = useRef<number | null | undefined>(undefined);

  // Constants for column widths to ensure perfect alignment
  const LABEL_CLS = "w-24 shrink-0"; // Increased width for longer names
  const INDEX_CLS = "w-8 text-right mr-2 shrink-0";
  const SEQ_CLS = "tracking-widest";

  // Map residue index to variant for quick lookup
  const variantMap = useMemo(() => {
    const map = new Map<number, Variant[]>();
    variants.forEach(v => {
      if (!map.has(v.residue)) map.set(v.residue, []);
      map.get(v.residue)?.push(v);
    });
    return map;
  }, [variants]);

  const chunks = useMemo(() => {
    const result = [];
    let humanPos = 0;
    let yeastPos = 0;

    for (let i = 0; i < humanSeq.length; i += LINE_WIDTH) {
      const sliceH = humanSeq.slice(i, i + LINE_WIDTH);
      const sliceY = yeastSeq.slice(i, i + LINE_WIDTH);
      
      let matchLine = "";
      let markerLine = "";
      let highlightIndexH = -1;
      
      // Calculate start positions for this line
      const lineStartH = humanPos + 1;
      const lineStartY = yeastPos + 1;

      for (let j = 0; j < sliceH.length; j++) {
        const aaH = sliceH[j];
        const aaY = sliceY[j];
        
        // Track actual residue numbers (ignoring gaps)
        const isResidueH = aaH !== '-';
        if (isResidueH) {
            humanPos++;
            // Check for selection match
            if (selectedResidue && humanPos === selectedResidue) {
                highlightIndexH = j;
            }
        }
        if (aaY !== '-') yeastPos++;

        // Match Logic
        if (aaH === '-' || aaY === '-') matchLine += '\u00A0'; // Non-breaking space
        else if (aaH === aaY) matchLine += '|';
        else if (isSimilarAA(aaH, aaY)) matchLine += ':';
        else matchLine += '\u00A0'; // Space for mismatch

        // Marker Logic
        if (isResidueH && variantMap.has(humanPos)) {
            const vs = variantMap.get(humanPos);
            // Ensure target AA is displayed if available
            markerLine += (vs && vs.length > 1) ? '*' : (vs?.[0].targetAA || 'v');
        } else {
            markerLine += '\u00A0';
        }
      }

      result.push({
        lineStartH,
        lineStartY,
        sliceH,
        sliceY,
        matchLine,
        markerLine,
        lineEndH: humanPos,
        lineEndY: yeastPos,
        highlightIndexH
      });
    }
    return result;
  }, [humanSeq, yeastSeq, variantMap, selectedResidue]);

  // Auto-scroll to selected residue - ONLY if it has changed
  useEffect(() => {
    if (selectedResidue !== null && selectedResidue !== undefined) {
      if (lastScrolledResidue.current !== selectedResidue) {
        const chunkIdx = chunks.findIndex(c => c.highlightIndexH !== -1);
        if (chunkIdx !== -1) {
          const el = document.getElementById(`alignment-chunk-${chunkIdx}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            lastScrolledResidue.current = selectedResidue;
          }
        }
      }
    }
  }, [selectedResidue, chunks]);

  const HighlightSpan: React.FC<{ char: string }> = ({ char }) => (
    <span className="bg-green-400 text-slate-900 font-bold border-b-2 border-red-500 animate-pulse inline-block min-w-[1ch] text-center">
      {char}
    </span>
  );

  return (
    <div className="font-mono text-xs overflow-x-auto bg-white p-4 rounded border border-gray-200 shadow-sm max-h-[500px] overflow-y-auto">
      <h3 className="font-bold mb-4 text-gray-700 sticky top-0 bg-white pb-2 border-b">
        Sequence Alignment <span className="text-gray-400 font-normal">(v = variant, * = multiple variants)</span>
      </h3>
      {chunks.map((chunk, idx) => (
        <div key={idx} id={`alignment-chunk-${idx}`} className="mb-6 whitespace-pre">
            {/* Marker Line */}
            <div className="flex h-4 items-end">
                <span className={LABEL_CLS}></span>
                <span className={INDEX_CLS}></span>
                <span className={`${SEQ_CLS} text-red-600 font-bold`}>
                    {chunk.markerLine.split('').map((char, i) => (
                        i === chunk.highlightIndexH ? <HighlightSpan key={i} char={char} /> : <span key={i}>{char}</span>
                    ))}
                </span>
            </div>
            
            {/* Human Seq */}
            <div className="flex">
                <span className={`${LABEL_CLS} text-gray-500 truncate`} title={humanName}>{humanName}</span>
                <span className={`${INDEX_CLS} text-gray-400`}>{chunk.lineStartH}</span>
                <span className={`${SEQ_CLS} text-slate-800`}>
                    {chunk.sliceH.split('').map((char, i) => (
                        i === chunk.highlightIndexH ? <HighlightSpan key={i} char={char} /> : <span key={i}>{char}</span>
                    ))}
                </span>
                <span className="w-8 ml-2 text-gray-400">{chunk.lineEndH}</span>
            </div>

            {/* Match Line */}
            <div className="flex">
                 <span className={LABEL_CLS}></span>
                 <span className={INDEX_CLS}></span>
                 <span className={`${SEQ_CLS} text-blue-400 font-bold`}>{chunk.matchLine}</span>
            </div>

            {/* Yeast Seq */}
            <div className="flex">
                <span className={`${LABEL_CLS} text-gray-500 truncate`} title={yeastName}>{yeastName}</span>
                <span className={`${INDEX_CLS} text-gray-400`}>{chunk.lineStartY}</span>
                <span className={`${SEQ_CLS} text-slate-800`}>
                    {chunk.sliceY.split('').map((char, i) => (
                        i === chunk.highlightIndexH ? <HighlightSpan key={i} char={char} /> : <span key={i}>{char}</span>
                    ))}
                </span>
                <span className="w-8 ml-2 text-gray-400">{chunk.lineEndY}</span>
            </div>
        </div>
      ))}
    </div>
  );
};
