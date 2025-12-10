import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Search, Activity, ArrowRight, Sparkles, CheckCircle, Mail, Globe, Dna, Info, ShieldCheck, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { GeneInfo, OrthologInfo, AlignmentResult, PipelineState, ClinicalInput, AnalyzedVariant, Variant } from './types';
import { getHumanGeneInfo, getOrtholog, fetchSequence, fetchSpecificVariantData } from './services/api';
import { alignSequences, parseInputVariant, isSimilarAA, AA_MAP_1_TO_3 } from './utils/alignment';
import { generateClinicalInterpretation } from './services/geminiService';
import { AlignmentView } from './components/AlignmentView';

export const App: React.FC = () => {
  // Input State
  const [input, setInput] = useState<ClinicalInput>({
    gene: '',
    variant: '',
    panel: 'None', 
    notes: ''
  });

  // Pipeline State
  const [state, setState] = useState<PipelineState>({ step: 'idle', logs: [] });
  
  // Data State
  const [geneInfo, setGeneInfo] = useState<GeneInfo | null>(null);
  const [ortholog, setOrtholog] = useState<OrthologInfo | null>(null);
  const [alignment, setAlignment] = useState<AlignmentResult | null>(null);
  const [analyzedVariant, setAnalyzedVariant] = useState<AnalyzedVariant | null>(null);
  const [aiInterpretation, setAiInterpretation] = useState<string>('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs]);

  // Memoize the variant list passed to AlignmentView to prevent re-renders/focus jumps
  const alignmentVariants = useMemo(() => {
    if (!analyzedVariant) return [];
    
    // Map the AnalyzedVariant to the legacy Variant interface expected by AlignmentView
    const mappedVariant: Variant = {
        hgvs: analyzedVariant.originalInput,
        proteinChange: analyzedVariant.originalInput,
        residue: analyzedVariant.residueIndex,
        refAA: analyzedVariant.refAA,
        targetAA: analyzedVariant.targetAA,
        conservedStatus: analyzedVariant.conservationStatus,
        yeastAA: analyzedVariant.yeastAA_Aligned,
        yeastPos: analyzedVariant.yeastPos.toString(),
        amScore: analyzedVariant.alphaMissenseScore || null,
        clinVarId: analyzedVariant.clinVarId
    };
    
    return [mappedVariant];
  }, [analyzedVariant]);

  const addLog = (msg: string) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, msg] }));
  };

  const handleError = (msg: string) => {
    setState(prev => ({ ...prev, step: 'error', error: msg, logs: [...prev.logs, `Error: ${msg}`] }));
  };

  const handleAnalyze = async () => {
    if (!input.gene || !input.variant) {
        handleError("Please provide both Gene Symbol and Variant.");
        return;
    }

    // Check for DNA variant input first
    let variantToParse = input.variant;
    // Simple heuristic for DNA: starts with c. or g. or contains numbers and >
    if (/^[cg]\.|[\d]+[A-Z]>[A-Z]/i.test(input.variant)) {
       addLog("Detected DNA variant. Attempting to resolve protein change...");
       try {
           // We use a broader search to let the API resolve the DNA change to a protein change
           // Note: This relies on fetchSpecificVariantData's logic to search by raw string if needed, 
           // but since our parseInputVariant requires protein syntax, we might need a pre-fetch step 
           // if the user inputs strictly DNA.
           // For now, let's rely on the user inputting Protein syntax mostly, or if we want to support DNA:
           // We would need to query MyVariant with the DNA change to get the HGVS protein.
           
           const dnaData = await fetchSpecificVariantData(input.gene, '', 0, '', input.variant);
           if (dnaData && dnaData.snpeff && dnaData.snpeff.aa) {
               const aaChange = Array.isArray(dnaData.snpeff.aa) ? dnaData.snpeff.aa[0] : dnaData.snpeff.aa;
               if (aaChange) {
                   addLog(`Resolved ${input.variant} to ${aaChange}`);
                   variantToParse = aaChange;
               }
           } else if (dnaData && dnaData.clinvar) {
                // Try to find protein change in ClinVar data
                const cv = Array.isArray(dnaData.clinvar) ? dnaData.clinvar[0] : dnaData.clinvar;
                if (cv && cv.hgvs && cv.hgvs.p) {
                     addLog(`Resolved ${input.variant} to ${cv.hgvs.p}`);
                     variantToParse = cv.hgvs.p;
                }
           }
       } catch (e) {
           addLog("Could not automatically resolve DNA to Protein change. Proceeding with raw input.");
       }
    }

    const parsedVar = parseInputVariant(variantToParse);
    if (!parsedVar) {
        handleError("Invalid variant format. Use 'p.Arg114Gln', 'R114Q', or try a DNA change 'c.340G>A'.");
        return;
    }

    // Reset Analysis
    setState({ step: 'analyzing', logs: [] });
    setGeneInfo(null);
    setOrtholog(null);
    setAlignment(null);
    setAnalyzedVariant(null);
    setAiInterpretation('');

    try {
        addLog(`Initiating clinical analysis for ${input.gene} : ${variantToParse}...`);

        // 1. Gene Info
        const gInfo = await getHumanGeneInfo(input.gene);
        setGeneInfo(gInfo);
        addLog(`Identified Human Gene: ${gInfo.symbol} (UniProt: ${gInfo.uniprot_id})`);

        if (!gInfo.uniprot_id) throw new Error("No UniProt ID found. Cannot perform sequence analysis.");

        // 2. Ortholog
        addLog("Querying DIOPT for Yeast Ortholog...");
        const orth = await getOrtholog(gInfo.entrez_id);
        if (!orth) throw new Error("No significant yeast ortholog found.");
        setOrtholog(orth);
        addLog(`Best Yeast Ortholog: ${orth.symbol} (Score: ${orth.score})`);

        // 3. Sequences
        addLog("Retrieving protein sequences...");
        const hSeq = await fetchSequence(gInfo.uniprot_id);
        const ySeq = await fetchSequence(orth.id, true);

        // 4. Alignment
        addLog("Performing pairwise alignment...");
        const alignRes = alignSequences(hSeq.seq, ySeq.seq);
        setAlignment({
            humanSeqAligned: alignRes.aligned1,
            yeastSeqAligned: alignRes.aligned2,
            score: 0 
        });

        // 5. Variant Localization & Conservation Check
        addLog(`Mapping variant ${parsedVar.ref}${parsedVar.res}${parsedVar.target} to alignment...`);
        
        let currentResCount = 0;
        let alignIndex = -1;
        
        for (let i = 0; i < alignRes.aligned1.length; i++) {
            if (alignRes.aligned1[i] !== '-') {
                currentResCount++;
                if (currentResCount === parsedVar.res) {
                    alignIndex = i;
                    break;
                }
            }
        }

        if (alignIndex === -1) {
            throw new Error(`Residue ${parsedVar.res} is out of bounds for the retrieved sequence.`);
        }

        const hChar = alignRes.aligned1[alignIndex];
        const yChar = alignRes.aligned2[alignIndex];

        if (hChar !== parsedVar.ref) {
            addLog(`WARNING: User input REF is ${parsedVar.ref}, but database sequence has ${hChar} at pos ${parsedVar.res}.`);
        }

        let status: AnalyzedVariant['conservationStatus'] = 'Mismatch';
        if (yChar === '-') status = 'Gap';
        else if (hChar === yChar) status = 'Identical';
        else if (isSimilarAA(hChar, yChar)) status = 'Similar';

        let yeastPos = 0;
        if (yChar !== '-') {
            for(let k=0; k<=alignIndex; k++) {
                if (alignRes.aligned2[k] !== '-') yeastPos++;
            }
        }

        // 6. External Data Lookup (gnomAD / ClinVar) - Specific Variant Search
        addLog("Querying external databases (ClinVar, gnomAD, AlphaMissense)...");
        // We use the parsed data: gene symbol, ref, pos, target
        const matchedRecord = await fetchSpecificVariantData(gInfo.symbol, parsedVar.ref, parsedVar.res, parsedVar.target, variantToParse);
        
        let amScore = undefined;
        let clinVarSig = undefined;
        let clinVarId = undefined;
        let gnomadFreq = undefined;

        // Helper to find value deep in object
        const findValueDeep = (obj: any, keyName: string): any => {
            if (!obj) return undefined;
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const res = findValueDeep(item, keyName);
                    if (res) return res;
                }
            } else if (typeof obj === 'object') {
                if (obj[keyName]) return obj[keyName];
                for (const k in obj) {
                    const res = findValueDeep(obj[k], keyName);
                    if (res) return res;
                }
            }
            return undefined;
        };

        if (matchedRecord) {
             addLog("Found record in external databases.");
             
             // Extract ClinVar
             // Try strict path first
             if (matchedRecord.clinvar) {
                 const cvEntry = Array.isArray(matchedRecord.clinvar) ? matchedRecord.clinvar[0] : matchedRecord.clinvar;
                 if (cvEntry) {
                     clinVarSig = cvEntry.rcv?.clinical_significance || cvEntry.clinical_significance;
                     clinVarId = cvEntry.rcv?.accession || cvEntry.variant_id;
                 }
             }
             // If not found, try deep search
             if (!clinVarSig) {
                clinVarSig = findValueDeep(matchedRecord.clinvar, 'clinical_significance');
             }

             // Extract AlphaMissense (Handle Array or Object)
             // Structure is usually hit.dbnsfp.alphamissense
             if (matchedRecord.dbnsfp && matchedRecord.dbnsfp.alphamissense) {
                 const amData = matchedRecord.dbnsfp.alphamissense;
                 if (Array.isArray(amData)) {
                     // If multiple scores (isoforms), take the maximum score to be conservative
                     const scores = amData.map((d: any) => parseFloat(d.score)).filter((s: number) => !isNaN(s));
                     if (scores.length > 0) amScore = Math.max(...scores);
                 } else if (amData.score) {
                     amScore = parseFloat(amData.score);
                 }
             }

             // Extract gnomAD
             // Check for undefined specifically, as 0 is a valid frequency
             if (matchedRecord.gnomad_exome?.af?.af !== undefined) gnomadFreq = matchedRecord.gnomad_exome.af.af;
             else if (matchedRecord.gnomad_genome?.af?.af !== undefined) gnomadFreq = matchedRecord.gnomad_genome.af.af;
        } else {
             addLog("No direct match found in ClinVar/gnomAD/dbNSFP for this specific variant.");
        }

        addLog(gnomadFreq !== undefined ? `gnomAD Frequency: ${gnomadFreq}` : "No gnomAD frequency data found.");
        addLog(clinVarSig ? `ClinVar Significance: ${clinVarSig}` : "No specific ClinVar classification found.");

        const finalVariant: AnalyzedVariant = {
            originalInput: variantToParse,
            residueIndex: parsedVar.res,
            refAA: hChar,
            targetAA: parsedVar.target,
            humanAA_Aligned: hChar,
            yeastAA_Aligned: yChar,
            conservationStatus: status,
            yeastPos: yeastPos,
            alphaMissenseScore: amScore,
            clinVarSignificance: clinVarSig,
            clinVarId: clinVarId,
            gnomadFrequency: gnomadFreq
        };

        setAnalyzedVariant(finalVariant);
        setState(prev => ({ ...prev, step: 'complete' }));

        // 7. AI Generation
        setIsGeneratingAi(true);
        const interp = await generateClinicalInterpretation(gInfo, orth, finalVariant, input.notes);
        setAiInterpretation(interp);
        setIsGeneratingAi(false);

    } catch (e) {
        handleError((e as Error).message);
    }
  };

  const handleGeneratePDF = () => {
    if (!analyzedVariant || !geneInfo || !ortholog) return;

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    let y = 20;

    // --- Header ---
    doc.setFontSize(22);
    doc.setTextColor(0, 128, 128); // Teal
    doc.text("noVUS Clinical Report", margin, y);
    y += 10;
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated by noVUS | ${new Date().toLocaleDateString()}`, margin, y);
    y += 15;

    // --- Clinical Data ---
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text("Clinical Data", margin, y);
    y += 10;

    doc.setFontSize(10);
    doc.text(`Gene: ${geneInfo.symbol} (${geneInfo.name})`, margin, y); y += 6;
    doc.text(`Variant: ${analyzedVariant.originalInput}`, margin, y); y += 6;
    
    y += 4;
    doc.text(`gnomAD Frequency: ${analyzedVariant.gnomadFrequency !== undefined ? analyzedVariant.gnomadFrequency.toExponential(2) : 'N/A'}`, margin, y); y += 6;
    doc.text(`ClinVar Status: ${analyzedVariant.clinVarSignificance || 'Not listed'}`, margin, y); y += 6;
    doc.text(`AlphaMissense: ${analyzedVariant.alphaMissenseScore?.toFixed(3) || 'N/A'}`, margin, y); y += 10;

    // --- Conservation ---
    doc.text("Evolutionary Conservation:", margin, y); y += 6;
    doc.text(`Human Residue: ${analyzedVariant.refAA}${analyzedVariant.residueIndex}`, margin + 5, y); y += 6;
    doc.text(`Yeast Ortholog: ${ortholog.symbol} -> ${analyzedVariant.yeastAA_Aligned}${analyzedVariant.yeastPos}`, margin + 5, y); y += 6;
    doc.text(`Status: ${analyzedVariant.conservationStatus}`, margin + 5, y); y += 15;

    // --- AI Interpretation ---
    doc.setFontSize(14);
    doc.text("Clinical Interpretation", margin, y);
    y += 10;
    doc.setFontSize(10);
    const splitInterp = doc.splitTextToSize(aiInterpretation.replace(/\*\*/g, '').replace(/#/g, ''), pageWidth - (margin*2));
    doc.text(splitInterp, margin, y);

    // --- Footer ---
    y += splitInterp.length * 5 + 15;
    
    // Check page break
    if (y > 270) {
        doc.addPage();
        y = 20;
    }

    doc.setFontSize(9);
    doc.setTextColor(0, 128, 128); // Teal
    const footerText = "If this variant is conserved, the Wasko research lab at the Western University of Health Sciences can likely perform a yeast-based assay to determine if the mutation is detrimental to protein function and provide functional evidence for whether it may be pathogenic or not. We are a small academic lab and will do this for no charge. Please reach out to noVUS@wasko.org";
    const splitFooter = doc.splitTextToSize(footerText, pageWidth - (margin*2));
    doc.text(splitFooter, margin, y);

    doc.save(`noVUS_Report_${geneInfo.symbol}.pdf`);
  };

  const sendRequestEmail = () => {
    if (!analyzedVariant || !geneInfo) return;
    const subject = `VUS Analysis Request: ${geneInfo.symbol} ${analyzedVariant.originalInput}`;
    const body = `Dear Wasko Lab,\n\nI would like to request an experimental functional analysis.\n\nGene: ${geneInfo.symbol}\nVariant: ${analyzedVariant.originalInput}\nConservation: ${analyzedVariant.conservationStatus}\n\nNotes:\n${input.notes}`;
    window.location.href = `mailto:VUSrequest@wasko.org?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const getAmDescription = (score: number) => {
    if (score > 0.56) return { text: "Likely Pathogenic", color: "text-red-600" };
    if (score >= 0.34) return { text: "Ambiguous", color: "text-amber-600" };
    return { text: "Likely Benign", color: "text-emerald-600" };
  };

  const isRare = analyzedVariant && analyzedVariant.gnomadFrequency !== undefined && analyzedVariant.gnomadFrequency < 0.01;
  const isCommon = analyzedVariant && analyzedVariant.gnomadFrequency !== undefined && analyzedVariant.gnomadFrequency >= 0.01;

  return (
    <div className="min-h-screen bg-slate-50 font-inter text-slate-900 flex flex-col">
      
      {/* Navigation */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="bg-teal-600 p-2 rounded-lg text-white">
                    <Activity className="w-5 h-5" />
                </div>
                <div>
                    <h1 className="text-lg font-bold text-slate-900 tracking-tight leading-none">noVUS <span className="text-teal-600 font-light"> Novel Ortholog Validation Using Saccharomyces </span></h1>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">VUS identification </p>
                </div>
            </div>
            <div className="text-xs text-slate-400 font-medium flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                Clinician Mode Active
            </div>
        </div>
      </header>

      <main className="flex-grow w-full max-w-6xl mx-auto px-6 py-10 space-y-8">
        
        {/* Input Section */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-1 bg-gradient-to-r from-teal-500 to-indigo-600"></div>
            <div className="p-8">
                <div className="flex justify-between items-start mb-6">
                    <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                        <Search className="w-5 h-5 text-slate-400" />
                        Variant Query
                    </h2>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                    <div className="md:col-span-3">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Gene Symbol</label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none transition-all"
                            placeholder="e.g. ATP6V1B1"
                            value={input.gene}
                            onChange={(e) => setInput({...input, gene: e.target.value.toUpperCase()})}
                        />
                    </div>
                    <div className="md:col-span-3">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Variant</label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-900 font-bold focus:ring-2 focus:ring-teal-500 outline-none transition-all"
                            placeholder="p.Asn387Lys, R114Q, c.1159A>G"
                            value={input.variant}
                            onChange={(e) => setInput({...input, variant: e.target.value})}
                        />
                    </div>
                    <div className="md:col-span-6">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Clinical Notes <span className="text-slate-300 font-normal normal-case">(Optional)</span></label>
                        <input 
                            type="text" 
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-700 focus:ring-2 focus:ring-teal-500 outline-none transition-all"
                            placeholder="e.g. Patient presents with dRTA; suspecting loss of function..."
                            value={input.notes}
                            onChange={(e) => setInput({...input, notes: e.target.value})}
                        />
                    </div>
                </div>

                <div className="mt-8 flex justify-end items-center gap-4">
                    {state.step === 'analyzing' && <span className="text-sm text-slate-500 animate-pulse">Querying global databases...</span>}
                    <button 
                        onClick={handleAnalyze}
                        disabled={state.step === 'analyzing'}
                        className="bg-slate-900 hover:bg-slate-800 text-white px-8 py-3 rounded-lg font-semibold shadow-lg shadow-slate-200 transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                        {state.step === 'analyzing' ? <Activity className="w-5 h-5 animate-spin"/> : <Dna className="w-5 h-5" />}
                        Run Analysis
                    </button>
                </div>
                
                {state.logs.length > 0 && (
                    <div className="mt-6 bg-slate-50 rounded-lg p-4 max-h-32 overflow-y-auto border border-slate-100">
                        <div className="text-[10px] font-mono space-y-1">
                            {state.logs.map((log, i) => (
                                <div key={i} className={log.includes('Error') || log.includes('WARNING') ? 'text-red-500' : 'text-slate-500'}>
                                    &gt; {log}
                                </div>
                            ))}
                            <div ref={logsEndRef} />
                        </div>
                    </div>
                )}
            </div>
        </section>

        {analyzedVariant && geneInfo && ortholog && alignment && (
            <div className="animate-fade-in space-y-8">
                
                {/* Scorecards */}
                <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Conservation Card */}
                    <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-6 relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-24 h-24 bg-teal-50 rounded-bl-full -mr-4 -mt-4 z-0"></div>
                        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-6 relative z-10">Evolutionary Conservation</h3>
                        
                        <div className="flex items-center justify-between relative z-10">
                            <div className="text-center">
                                <div className="text-xs text-slate-400 mb-1">Human</div>
                                <div className="text-4xl font-black text-slate-800">{analyzedVariant.refAA}<span className="text-lg text-slate-400 font-medium align-top">{analyzedVariant.residueIndex}</span></div>
                            </div>

                            <ArrowRight className="w-8 h-8 text-slate-300" />

                            <div className="text-center">
                                <div className="text-xs text-slate-400 mb-1">Yeast ({ortholog.symbol})</div>
                                <div className="text-4xl font-black text-slate-800">{analyzedVariant.yeastAA_Aligned}<span className="text-lg text-slate-400 font-medium align-top">{analyzedVariant.yeastPos > 0 ? analyzedVariant.yeastPos : '-'}</span></div>
                            </div>

                            <div className="h-16 w-px bg-slate-100 mx-4"></div>

                            <div className="flex-grow">
                                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold border ${
                                    analyzedVariant.conservationStatus === 'Identical' 
                                        ? 'bg-teal-50 text-teal-700 border-teal-100' 
                                        : analyzedVariant.conservationStatus === 'Similar'
                                        ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                                        : 'bg-slate-50 text-slate-600 border-slate-200'
                                }`}>
                                    {analyzedVariant.conservationStatus === 'Identical' && <CheckCircle className="w-4 h-4" />}
                                    {analyzedVariant.conservationStatus === 'Similar' && <Info className="w-4 h-4" />}
                                    {analyzedVariant.conservationStatus}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Population & Clinical Data Card */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
                         <div>
                            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-4">Population & Pathogenicity</h3>
                            
                            {/* gnomAD Frequency */}
                            <div className="mb-4">
                                <div className="flex justify-between items-end mb-1">
                                    <span className="text-xs text-slate-400">gnomAD Frequency</span>
                                    <span className="text-sm font-bold text-slate-800">
                                        {analyzedVariant.gnomadFrequency !== undefined
                                            ? analyzedVariant.gnomadFrequency.toExponential(2) 
                                            : <span className="text-slate-400 italic">Not in gnomAD</span>}
                                    </span>
                                </div>
                                <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                                    <div 
                                        className={`h-full ${analyzedVariant.gnomadFrequency === undefined ? 'bg-slate-300' : analyzedVariant.gnomadFrequency < 0.0001 ? 'bg-red-500' : 'bg-green-500'}`}
                                        style={{ width: analyzedVariant.gnomadFrequency === undefined ? '0%' : '100%' }}
                                    ></div>
                                </div>
                                <div className="text-[10px] mt-1 flex justify-between">
                                    <span className={isRare ? "text-blue-600 font-bold" : "text-slate-400"}>Rare</span>
                                    <span className={isCommon ? "text-blue-600 font-bold" : "text-slate-400"}>Common</span>
                                </div>
                            </div>

                            {/* ClinVar & AlphaMissense */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center bg-slate-50 p-2 rounded">
                                    <span className="text-xs text-slate-500">ClinVar</span>
                                    <span className={`text-xs font-bold ${analyzedVariant.clinVarSignificance?.toLowerCase().includes('pathogenic') ? 'text-red-600' : 'text-slate-700'}`}>
                                        {analyzedVariant.clinVarSignificance || 'Unclassified'}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center bg-slate-50 p-2 rounded">
                                    <span className="text-xs text-slate-500">AlphaMissense AI Score </span>
                                    <div className="text-right">
                                        <span className={`text-xs font-bold block ${analyzedVariant.alphaMissenseScore && analyzedVariant.alphaMissenseScore > 0.56 ? 'text-red-600' : 'text-slate-700'}`}>
                                            {analyzedVariant.alphaMissenseScore?.toFixed(3) || 'N/A'}
                                        </span>
                                        {analyzedVariant.alphaMissenseScore !== undefined && analyzedVariant.alphaMissenseScore !== null && (
                                            <span className={`text-[10px] font-medium block ${getAmDescription(analyzedVariant.alphaMissenseScore).color}`}>
                                                {getAmDescription(analyzedVariant.alphaMissenseScore).text}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                         </div>
                         
                         <div className="flex gap-2 mt-4">
                            {analyzedVariant.clinVarId && (
                                <a href={`https://www.ncbi.nlm.nih.gov/clinvar/variation/${analyzedVariant.clinVarId}`} target="_blank" rel="noreferrer" className="flex-1 text-center py-1.5 bg-indigo-50 text-indigo-600 rounded text-xs font-bold hover:bg-indigo-100 transition-colors">
                                    ClinVar
                                </a>
                            )}
                             <a 
                                href={geneInfo.ensembl_id ? `https://gnomad.broadinstitute.org/gene/${geneInfo.ensembl_id}?dataset=gnomad_r4` : `https://gnomad.broadinstitute.org/gene/${geneInfo.symbol}?dataset=gnomad_r4`} 
                                target="_blank" rel="noreferrer" 
                                className="flex-1 text-center py-1.5 bg-emerald-50 text-emerald-600 rounded text-xs font-bold hover:bg-emerald-100 transition-colors flex items-center justify-center gap-1"
                             >
                                gnomAD <Globe className="w-3 h-3" />
                            </a>
                         </div>
                    </div>
                </section>

                {/* Call to Action (Validate Variant) */}
                <section className="bg-teal-50 border border-teal-100 rounded-xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div>
                        <h3 className="text-xl font-bold text-teal-900 mb-2">Would you like our lab to validate this variant?</h3>
                        <p className="text-teal-700 text-sm max-w-2xl">
                            If this variant is conserved, our lab can likely perform a yeast-based assay to determine if the mutation is detrimental to protein function and provide functional evidence for whether it may be pathogenic or not. We are a small academic lab and will do this for no charge, but we might be interested in publishing with your inclusion as an co-author.
                        </p>
                    </div>
                    <button 
                        onClick={sendRequestEmail}
                        className="bg-teal-600 hover:bg-teal-700 text-white px-6 py-3 rounded-lg font-semibold shadow-sm transition-all flex items-center gap-2 whitespace-nowrap"
                    >
                        <Mail className="w-4 h-4" />
                        Email Experiment Request
                    </button>
                </section>

                {/* Clinical AI Interpretation */}
                <section className="bg-gradient-to-br from-indigo-900 to-slate-900 rounded-xl shadow-md p-8 text-white relative overflow-hidden">
                    <Sparkles className="absolute top-6 right-6 text-indigo-400 w-6 h-6 opacity-50" />
                    <h3 className="text-sm font-bold text-indigo-200 uppercase tracking-wider mb-4">Clinical Interpretation (AI)</h3>
                    
                    {isGeneratingAi ? (
                        <div className="flex items-center gap-3 text-indigo-300">
                            <Activity className="w-5 h-5 animate-spin" />
                            Thinking...
                        </div>
                    ) : (
                        <div className="prose prose-invert prose-sm max-w-none text-indigo-100 leading-relaxed">
                            <ReactMarkdown>{aiInterpretation}</ReactMarkdown>
                        </div>
                    )}
                    
                    <div className="mt-6 pt-6 border-t border-indigo-800 flex justify-end">
                        <button 
                            onClick={handleGeneratePDF}
                            className="text-indigo-300 text-xs font-bold flex items-center gap-2 hover:bg-indigo-800 px-3 py-2 rounded transition-colors"
                        >
                            <Download className="w-4 h-4" />
                            Download Clinical Report (PDF)
                        </button>
                    </div>
                </section>

                {/* Visual Alignment */}
                <section>
                    <AlignmentView 
                        humanSeq={alignment.humanSeqAligned}
                        yeastSeq={alignment.yeastSeqAligned}
                        variants={alignmentVariants} 
                        humanName={geneInfo.symbol}
                        yeastName={ortholog.symbol}
                        selectedResidue={analyzedVariant.residueIndex}
                    />
                </section>

            </div>
        )}

      </main>
    </div>
  );
};