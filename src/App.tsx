
import React, { useState, useEffect, useRef } from 'react';
import { Search, Dna, Activity, Zap, FileText, AlertCircle, PlayCircle, Key, Settings, ExternalLink, Info, List, ArrowRight, Sparkles, Filter, FlaskConical, Copy, Download, HelpCircle, ChevronDown, Mail } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { GeneInfo, OrthologInfo, Variant, Phenotype, PipelineState, AlignmentResult, RepairResult, Cas9Site } from './types';
import { getHumanGeneInfo, getOrtholog, fetchSequence, fetchClinVarVariants, fetchYeastPhenotypes, searchHumanGenes, fetchYeastGeneSequence } from './services/api';
import { alignSequences, parseProteinChange, isSimilarAA, AA_MAP } from './utils/alignment';
import { findCas9Sites, generateRepairTemplates, reverseComplement } from './utils/crispr';
import { generateExperimentalPlan } from './services/geminiService';
import { AlignmentView } from './components/AlignmentView';

// Helper to render colored REF DNA with PAM
const renderRefDna = (seq: string, site: Cas9Site, homologyStart: number) => {
  const pamStartRel = site.position - homologyStart;
  let pamStart = -1;
  let pamEnd = -1;

  if (site.strand === 'forward') {
    pamStart = pamStartRel + 20;
    pamEnd = pamStart + 3;
  } else {
    pamStart = pamStartRel;
    pamEnd = pamStart + 3;
  }

  return (
    <span>
      {seq.split('').map((char, i) => {
         const isPam = i >= pamStart && i < pamEnd;
         return isPam ? <span key={i} className="text-purple-400 font-bold">{char}</span> : char;
      })}
    </span>
  );
};

// Helper to render ALT sequence with differences highlighted
const renderAltSeq = (ref: string, alt: string) => {
   return (
     <span>
       {alt.split('').map((char, i) => {
         // Safe access to ref
         const refChar = ref[i] || '';
         const isDiff = char !== refChar;
         return isDiff ? <span key={i} className="text-red-500 font-bold">{char}</span> : char;
       })}
     </span>
   );
};

// New Helper to render Guide Sequence with PAM Highlight
const renderGuideWithPam = (guideSeqWithPam: string) => {
    // Last 3 chars are PAM
    const guide = guideSeqWithPam.substring(0, 20);
    const pam = guideSeqWithPam.substring(20);
    return (
        <span>
            {guide}
            <span className="text-purple-600 font-bold">{pam}</span>
        </span>
    );
};

export const App: React.FC = () => {
  // UI Mode
  const [inputMode, setInputMode] = useState<'manual' | 'topic'>('manual');
  
  // Input State
  const [geneInput, setGeneInput] = useState('ATP6V1B1');
  const [topicInput, setTopicInput] = useState('');
  const [topicResults, setTopicResults] = useState<{symbol: string, name: string, entrez_id: string, dioptScore?: number}[]>([]);
  const [isSearchingTopic, setIsSearchingTopic] = useState(false);
  const [isFilteringOrthologs, setIsFilteringOrthologs] = useState(false);
  
  const [minScore, setMinScore] = useState(0.0);
  const [maxScore, setMaxScore] = useState(1.0);
  const [isAboutVisible, setIsAboutVisible] = useState(true);

  // Pipeline Data State
  const [state, setState] = useState<PipelineState>({ step: 'idle', logs: [] });
  const [geneInfo, setGeneInfo] = useState<GeneInfo | null>(null);
  const [ortholog, setOrtholog] = useState<OrthologInfo | null>(null);
  const [alignment, setAlignment] = useState<AlignmentResult | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [phenotypes, setPhenotypes] = useState<Phenotype[]>([]);
  const [aiPlan, setAiPlan] = useState<string>('');
  
  // Selection State
  const [selectedVariantIndex, setSelectedVariantIndex] = useState<number | null>(null);
  const [selectedPhenotype, setSelectedPhenotype] = useState<string | null>(null);
  const [visibleVariantsCount, setVisibleVariantsCount] = useState(10);
  
  // AI Generation State
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);

  // CRISPR State
  const [isGeneratingCrispr, setIsGeneratingCrispr] = useState(false);
  const [crisprResults, setCrisprResults] = useState<RepairResult[]>([]);

  // Refs
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs, state.error]);

  const addLog = (msg: string) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, msg] }));
  };

  const handleError = (msg: string) => {
    setState(prev => ({ ...prev, step: 'error', error: msg, logs: [...prev.logs, `Error: ${msg}`] }));
  };

  const handleTopicSearch = async () => {
    if (!topicInput.trim()) return;
    setIsSearchingTopic(true);
    setTopicResults([]);
    try {
      const results = await searchHumanGenes(topicInput);
      setTopicResults(results);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSearchingTopic(false);
    }
  };

  const handleFilterOrthologs = async () => {
    if (topicResults.length === 0) return;
    setIsFilteringOrthologs(true);
    addLog(`Checking ${topicResults.length} genes for yeast orthologs (this may take a a few minutes, please be patient)...`);

    const validGenes: typeof topicResults = [];
    const BATCH_SIZE = 5;

    try {
        for (let i = 0; i < topicResults.length; i += BATCH_SIZE) {
            const batch = topicResults.slice(i, i + BATCH_SIZE);
            
            // Run batch in parallel
            await Promise.all(batch.map(async (gene) => {
                try {
                    const orth = await getOrtholog(gene.entrez_id);
                    if (orth) {
                        validGenes.push({ ...gene, dioptScore: orth.score });
                    }
                } catch (e) {
                    console.warn(`Failed to check ortholog for ${gene.symbol}`, e);
                }
            }));
            
            // Small delay to be gentle on APIs
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Sort by DIOPT score descending
        validGenes.sort((a, b) => (b.dioptScore || 0) - (a.dioptScore || 0));

        setTopicResults(validGenes);
        addLog(`Filter complete. Retained ${validGenes.length} genes with yeast orthologs.`);
    } catch (e) {
        handleError("Error filtering orthologs.");
    } finally {
        setIsFilteringOrthologs(false);
    }
  };

  const runPipeline = async (identifier?: string) => {
    // Reset state
    setState({ step: 'searching', logs: [] });
    setGeneInfo(null);
    setOrtholog(null);
    setAlignment(null);
    setVariants([]);
    setPhenotypes([]);
    setAiPlan('');
    setCrisprResults([]);
    setSelectedVariantIndex(null);
    setSelectedPhenotype(null);
    setVisibleVariantsCount(10);
    
    // Determine input
    const inputTerm = identifier || geneInput;
    if (!inputTerm) {
        handleError("Please enter a gene symbol.");
        return;
    }

    try {
      addLog(`Starting pipeline...`);
      
      // 1. Human Gene Info
      addLog(`Searching for human gene: ${inputTerm}...`);
      const gInfo = await getHumanGeneInfo(inputTerm);
      setGeneInfo(gInfo);
      
      // Sync UI if we used a direct identifier (like from topic search)
      if (identifier) setGeneInput(gInfo.symbol);
      
      addLog(`Found: ${gInfo.symbol} (ID: ${gInfo.entrez_id}) (UniProt: ${gInfo.uniprot_id || 'N/A'})`);
      
      if (!gInfo.uniprot_id) {
          throw new Error("No UniProt ID found for this gene. Cannot proceed with sequence analysis.");
      }

      // 2. Yeast Ortholog
      addLog(`Searching DIOPT for ortholog (ID: ${gInfo.entrez_id})...`);
      const orth = await getOrtholog(gInfo.entrez_id);
      if (!orth) {
        throw new Error("No Yeast ortholog found in DIOPT.");
      }
      setOrtholog(orth);
      addLog(`Ortholog found: ${orth.symbol} (Score: ${orth.score})`);

      // 3. Sequences
      addLog("Fetching sequences...");
      const humanSeqRecord = await fetchSequence(gInfo.uniprot_id);
      const yeastSeqRecord = await fetchSequence(orth.id, true); // true for yeast logic

      // 4. Alignment
      addLog("Aligning sequences (this may take a moment)...");
      const alignRes = alignSequences(humanSeqRecord.seq, yeastSeqRecord.seq);
      
      // Calculate Stats
      let identityCount = 0;
      let similarityCount = 0;
      let totalAligned = 0;
      for (let i = 0; i < alignRes.aligned1.length; i++) {
        const c1 = alignRes.aligned1[i];
        const c2 = alignRes.aligned2[i];
        if (c1 !== '-' || c2 !== '-') {
           totalAligned++;
           if (c1 !== '-' && c2 !== '-') {
               if (c1 === c2) {
                   identityCount++;
                   similarityCount++;
               } else if (isSimilarAA(c1, c2)) {
                   similarityCount++;
               }
           }
        }
      }
      const pIdentity = (identityCount / totalAligned) * 100;
      const pSimilarity = (similarityCount / totalAligned) * 100;

      setAlignment({
          humanSeqAligned: alignRes.aligned1,
          yeastSeqAligned: alignRes.aligned2,
          score: 0,
          percentIdentity: pIdentity,
          percentSimilarity: pSimilarity
      });
      addLog("Alignment complete.");

      // 5. Variants (ClinVar + AlphaMissense)
      addLog("Fetching ClinVar VUS & AlphaMissense data...");
      const rawHits = await fetchClinVarVariants(gInfo.symbol);
      addLog(`Found ${rawHits.length} raw hits. Parsing...`);

      const parsedVariants: Variant[] = [];
      let amSource = 'simulated';

      for (const hit of rawHits) {
         // Handle ClinVar structure (array vs obj)
         let clinVarEntry = hit.clinvar;
         if (Array.isArray(clinVarEntry)) clinVarEntry = clinVarEntry[0];
         
         const pChange = clinVarEntry?.hgvs?.protein;
         const pChangeStr = Array.isArray(pChange) ? pChange[0] : pChange;

         if (pChangeStr && pChangeStr.includes('p.')) {
            const parsed = parseProteinChange(pChangeStr);
            if (parsed) {
                // Check Conservation
                // Map parsed.res (1-based) to alignment index
                // We need to find the index i where humanSeqAligned has parsed.res non-gap characters up to it
                let currentResCount = 0;
                let alignIndex = -1;
                for (let i = 0; i < alignRes.aligned1.length; i++) {
                    if (alignRes.aligned1[i] !== '-') {
                        currentResCount++;
                        if (currentResCount === parsed.res) {
                            alignIndex = i;
                            break;
                        }
                    }
                }
                
                let status: Variant['conservedStatus'] = 'N/A';
                let yeastAA = '-';
                let yeastPos = '-';

                if (alignIndex !== -1) {
                    const hChar = alignRes.aligned1[alignIndex];
                    const yChar = alignRes.aligned2[alignIndex];
                    
                    if (hChar !== parsed.ref) {
                       // Mismatch in reference? warn?
                    }
                    
                    if (yChar === '-') {
                        status = 'Gap';
                    } else {
                        // Calculate Yeast Pos
                        let yCount = 0;
                        for(let k=0; k<=alignIndex; k++) {
                            if (alignRes.aligned2[k] !== '-') yCount++;
                        }
                        yeastAA = yChar;
                        yeastPos = yCount.toString();

                        if (hChar === yChar) status = 'Identical';
                        else if (isSimilarAA(hChar, yChar)) status = 'Similar';
                        else status = 'Mismatch';
                    }
                }
                
                // AlphaMissense Score from dbNSFP
                let amScore = null;
                if (hit.dbnsfp && hit.dbnsfp.alphamissense && hit.dbnsfp.alphamissense.score) {
                    amScore = parseFloat(hit.dbnsfp.alphamissense.score);
                    amSource = 'real';
                }

                // Filtering: Range AND Conservation
                // Strict: Must have Identical or Similar status
                if ((status === 'Identical' || status === 'Similar')) {
                    // Check score if it exists
                    if (amScore !== null) {
                        if (amScore >= minScore && amScore <= maxScore) {
                            // Clean protein change string for display (remove prefix)
                            let cleanName = pChangeStr;
                            // Regex to strictly extract the AA change part (e.g., Arg28Glu)
                            const hgvsMatch = cleanName.match(/p\.([A-Z][a-z]{2}\d+[A-Z][a-z]{2})/);
                            
                            if (hgvsMatch) {
                                cleanName = hgvsMatch[1];
                            } else {
                                // Fallback
                                if (cleanName.includes(':')) {
                                    cleanName = cleanName.split(':')[1];
                                }
                                cleanName = cleanName.replace('p.', '');
                            }

                            parsedVariants.push({
                                hgvs: pChangeStr,
                                proteinChange: cleanName,
                                residue: parsed.res,
                                refAA: parsed.ref,
                                targetAA: parsed.target,
                                conservedStatus: status,
                                yeastAA,
                                yeastPos,
                                amScore,
                                clinVarId: clinVarEntry.rcv?.[0]?.accession || clinVarEntry.rcv?.accession,
                                clinVarVariantId: clinVarEntry.variant_id
                            });
                        }
                    } else {
                       // If no score, and range allows null? Assuming range strict for demo
                    }
                }
            }
         }
      }
      
      // Sort variants by residue position
      parsedVariants.sort((a, b) => a.residue - b.residue);

      setVariants(parsedVariants);
      addLog(`Analysis complete. Found ${parsedVariants.length} variants in range.`);

      // 6. Phenotypes
      addLog("Fetching Yeast phenotypes...");
      const phenos = await fetchYeastPhenotypes(orth.id);
      setPhenotypes(phenos);
      addLog(`Found ${phenos.length} relevant phenotypes.`);
      
      setState(prev => ({ ...prev, step: 'complete' }));
      addLog("Pipeline finished. Ready for variant selection and AI Plan generation.");

    } catch (err) {
      handleError((err as Error).message);
    }
  };

  const toggleVariantSelection = (index: number) => {
      if (selectedVariantIndex === index) {
          setSelectedVariantIndex(null);
      } else {
          setSelectedVariantIndex(index);
      }
      // Reset dependent data
      setCrisprResults([]);
      setAiPlan('');
  };

  const togglePhenotypeSelection = (pheno: string) => {
    if (selectedPhenotype === pheno) {
        setSelectedPhenotype(null);
    } else {
        setSelectedPhenotype(pheno);
    }
    // Reset AI Plan to force regeneration with new context
    setAiPlan('');
  };

  const handleGeneratePlan = async () => {
    if (!geneInfo || !ortholog) return;
    
    setIsGeneratingAI(true);
    addLog("Generating AI Experimental Plan...");
    
    const selectedVariant = selectedVariantIndex !== null ? variants[selectedVariantIndex] : null;

    try {
      const plan = await generateExperimentalPlan(geneInfo.symbol, ortholog.symbol, phenotypes, variants, selectedVariant, selectedPhenotype);
      setAiPlan(plan);
      addLog("AI Plan generated successfully.");
    } catch (err) {
      addLog(`Error generating AI plan: ${(err as Error).message}`);
    } finally {
      setIsGeneratingAI(false);
    }
  };

  const handleGenerateCrispr = async () => {
    if (!ortholog || selectedVariantIndex === null) return;
    const selectedVariant = variants[selectedVariantIndex];
    
    setIsGeneratingCrispr(true);
    setCrisprResults([]);
    addLog(`Fetching Yeast Genomic DNA for ${ortholog.symbol} from Ensembl...`);

    try {
        const dnaSeq = await fetchYeastGeneSequence(ortholog.symbol);
        const yeastPos = parseInt(selectedVariant.yeastPos);
        
        if (isNaN(yeastPos)) throw new Error("Invalid Yeast Position for variant.");

        addLog("Scanning for Cas9 sites and designing repair templates...");
        const cas9Sites = findCas9Sites(dnaSeq, yeastPos);
        const templates = generateRepairTemplates(dnaSeq, cas9Sites, yeastPos, selectedVariant.targetAA);

        if (templates.length === 0) {
            addLog("No valid CRISPR repair templates found (pam constraints).");
        } else {
            setCrisprResults(templates);
            addLog(`Found ${templates.length} CRISPR primer designs.`);
        }
    } catch (e) {
        addLog(`CRISPR Design Error: ${(e as Error).message}`);
    } finally {
        setIsGeneratingCrispr(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could add toast notification here
  };
  
  const handleShowMore = () => {
    setVisibleVariantsCount(prev => Math.min(prev + 20, variants.length));
  };

  const handleExportPdf = async () => {
      if (!geneInfo) return;
      
      const doc = new jsPDF();
      let yPos = 20;
      const margin = 20;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const contentWidth = pageWidth - 2 * margin;
      
      const checkPageBreak = (spaceNeeded: number = 20) => {
          if (yPos + spaceNeeded > pageHeight - margin) {
              doc.addPage();
              yPos = 20;
          }
      };

      const addPageNumbers = () => {
          const pageCount = doc.getNumberOfPages();
          for (let i = 1; i <= pageCount; i++) {
              doc.setPage(i);
              doc.setFontSize(8);
              doc.setTextColor(150);
              doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 20, pageHeight - 10);
          }
      };

      // --- Header ---
      doc.setFontSize(18);
      doc.setTextColor(0);
      doc.text("BUDDY Analysis Report", margin, yPos);
      yPos += 10;
      
      doc.setDrawColor(200);
      doc.line(margin, yPos, pageWidth - margin, yPos);
      yPos += 10;
      
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, margin, yPos);
      yPos += 10;

      // --- Gene Info ---
      doc.setFontSize(14);
      doc.setTextColor(0);
      doc.text("Gene Information", margin, yPos);
      yPos += 8;
      
      doc.setFontSize(10);
      doc.setTextColor(50);
      doc.text(`Human Gene: ${geneInfo.symbol} (ID: ${geneInfo.entrez_id}, UniProt: ${geneInfo.uniprot_id})`, margin, yPos);
      yPos += 6;
      if (ortholog) {
          doc.text(`Yeast Ortholog: ${ortholog.symbol} (ID: ${ortholog.id}, DIOPT Score: ${ortholog.score})`, margin, yPos);
          yPos += 6;
      }
      if (alignment) {
          doc.text(`Identity: ${alignment.percentIdentity?.toFixed(1)}% | Similarity: ${alignment.percentSimilarity?.toFixed(1)}%`, margin, yPos);
          yPos += 10;
      }
      
      // --- Selected Variant ---
      if (selectedVariantIndex !== null) {
          const v = variants[selectedVariantIndex];
          checkPageBreak(40);
          doc.setFontSize(14);
          doc.setTextColor(0);
          doc.text("Selected Variant Analysis", margin, yPos);
          yPos += 8;
          
          doc.setFontSize(10);
          doc.setTextColor(50);
          doc.text(`Variant: ${v.proteinChange}`, margin, yPos); yPos += 6;
          doc.text(`Conservation: ${v.conservedStatus}`, margin, yPos); yPos += 6;
          doc.text(`Mapping: Human ${v.refAA}${v.residue} -> Yeast ${v.yeastAA}${v.yeastPos}`, margin, yPos); yPos += 6;
          
          let amDesc = "";
          if (v.amScore !== null && v.amScore !== undefined) {
             if (v.amScore > 0.56) amDesc = " (Likely Pathogenic)";
             else if (v.amScore >= 0.34) amDesc = " (Ambiguous)";
             else amDesc = " (Likely Benign)";
          }

          doc.text(`AlphaMissense Score: ${v.amScore?.toFixed(3) || 'N/A'}${amDesc}`, margin, yPos); yPos += 10;
          
          // New Text Alignment Logic
          if (alignment) {
              // Find the variant index in the aligned sequence
              let currentResCount = 0;
              let alignIndex = -1;
              for (let i = 0; i < alignment.humanSeqAligned.length; i++) {
                  if (alignment.humanSeqAligned[i] !== '-') {
                      currentResCount++;
                      if (currentResCount === v.residue) {
                          alignIndex = i;
                          break;
                      }
                  }
              }

              if (alignIndex !== -1) {
                  const windowSize = 25; 
                  const start = Math.max(0, alignIndex - windowSize);
                  const end = Math.min(alignment.humanSeqAligned.length, alignIndex + windowSize + 1);
                  
                  const seqH = alignment.humanSeqAligned.slice(start, end);
                  const seqY = alignment.yeastSeqAligned.slice(start, end);
                  
                  // Marker Line
                  let markerLine = "       "; // Indent for "Human: "
                  for(let k=0; k < seqH.length; k++) {
                      if (start + k === alignIndex) {
                          markerLine += v.targetAA;
                      } else {
                          markerLine += " ";
                      }
                  }

                  // Match Line
                  let matchLine = "       ";
                  for(let k=0; k < seqH.length; k++) {
                       const h = seqH[k];
                       const y = seqY[k];
                       if (h === '-' || y === '-') matchLine += " ";
                       else if (h === y) matchLine += "|";
                       else if (isSimilarAA(h, y)) matchLine += ":";
                       else matchLine += " ";
                  }

                  checkPageBreak(25);
                  doc.setFont("courier", "bold");
                  doc.setFontSize(8);
                  doc.setTextColor(0);

                  doc.text(markerLine, margin, yPos);
                  doc.text(`Human: ${seqH}`, margin, yPos + 4);
                  doc.text(matchLine, margin, yPos + 8);
                  doc.text(`Yeast: ${seqY}`, margin, yPos + 12);
                  
                  yPos += 20;
                  
                  // Restore Font
                  doc.setFont("helvetica", "normal");
                  doc.setFontSize(10);
                  doc.setTextColor(50);
              }
          }
      }

      // --- CRISPR Info ---
      if (crisprResults.length > 0) {
          checkPageBreak(60);
          const c = crisprResults[0];
          doc.setFontSize(14);
          doc.setTextColor(0);
          doc.text("CRISPR Design (pML104)", margin, yPos);
          yPos += 8;
          
          doc.setFontSize(10);
          doc.setFont("courier");
          doc.setTextColor(50);
          
          doc.text(`Guide Seq: ${c.guideSeqWithPam}`, margin, yPos); yPos += 6;
          doc.text(`Score: ${c.score || 'N/A'}`, margin, yPos); yPos += 6;
          
          doc.setFontSize(6); // Small font for long templates
          doc.text(`Repair Template (Var): ${c.repairTemplate}`, margin, yPos); yPos += 6;
          doc.text(`Repair Template (Del): ${c.deletionRepairTemplate}`, margin, yPos); yPos += 6;
          doc.text(`Oligo A: ${c.cloningOligoA}`, margin, yPos); yPos += 6;
          doc.text(`Oligo B: ${c.cloningOligoB}`, margin, yPos); yPos += 10;
          
          doc.setFontSize(10);
          doc.setFont("helvetica");
      }

      // --- AI Plan ---
      if (aiPlan) {
          checkPageBreak(60);
          doc.setFontSize(14);
          doc.setTextColor(0);
          doc.text("AI Experimental Plan", margin, yPos);
          yPos += 8;
          
          doc.setFontSize(10);
          doc.setTextColor(50);
          
          const cleanPlan = aiPlan.replace(/\*\*|#/g, ''); 
          const splitText = doc.splitTextToSize(cleanPlan, contentWidth);
          const lineHeight = 5;

          for (let i = 0; i < splitText.length; i++) {
              if (yPos + lineHeight > pageHeight - margin) {
                  doc.addPage();
                  yPos = 20; 
              }
              doc.text(splitText[i], margin, yPos);
              yPos += lineHeight;
          }
      }

      addPageNumbers();
      doc.save(`BUDDY_Report_${geneInfo.symbol}_${selectedVariantIndex !== null ? 'Variant' : 'Summary'}.pdf`);
  };

  const getScoreColor = (score: number) => {
    if (score >= 60) return "bg-green-100 text-green-800 border-green-200";
    if (score >= 40) return "bg-yellow-100 text-yellow-800 border-yellow-200";
    return "bg-red-100 text-red-800 border-red-200";
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-2 rounded-lg relative overflow-hidden group">
                 {/* Custom Budding Yeast + DNA Icon Composite */}
                 <div className="relative w-6 h-6">
                     {/* Mother Cell */}
                     <div className="absolute inset-0 border-2 border-white rounded-full"></div>
                     {/* Bud */}
                     <div className="absolute -top-1 -right-1 w-3 h-3 bg-white rounded-full border-2 border-indigo-600"></div>
                     {/* DNA Helix (Simplified inside) */}
                     <Dna className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 text-white" />
                 </div>
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              BUDDY
            </h1>
          </div>
          <div className="text-sm text-slate-500 font-medium">
            Bioinformatic Utility for Diagnostic Discovery in Yeast
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 flex-grow w-full pb-20">
        
        {/* Intro / About Box */}
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl overflow-hidden animate-fade-in">
             <button 
                onClick={() => setIsAboutVisible(!isAboutVisible)}
                className="w-full p-4 flex justify-between items-center bg-indigo-100/50 hover:bg-indigo-100 transition-colors"
             >
                 <div className="flex gap-4 items-center">
                    <Info className="w-6 h-6 text-indigo-600 shrink-0" />
                    <h3 className="font-bold text-indigo-800 text-base">About BUDDY & How to Use</h3>
                 </div>
                 <ChevronDown className={`w-5 h-5 text-indigo-500 transition-transform ${isAboutVisible ? 'rotate-180' : ''}`} />
             </button>

             {isAboutVisible && (
                 <div className="p-6 text-sm text-indigo-900 prose prose-sm max-w-none prose-h4:font-bold prose-h4:text-indigo-800 prose-ul:pl-5">
                    <h4>BUDDY is a bioinformatics platform that streamlines the use of yeast to test the functional impact of human variants of unknown significance (VUS).</h4>
                    <p>
                      
                    </p>
                    
                    <h4>How to Run Analysis</h4>
                    <ul>
                        <li><strong>Input:</strong> Enter a Human Gene Name and set your AlphaMissense score range.</li>
                        <li><strong>Search:</strong> Click Run, or use "Search by Topic" (refine results by clicking "Filter for Yeast Orthologs").</li>
                    </ul>
                    <p><strong>Score Guide:</strong></p>
                    <ul>
                        <li><strong>  Ambiguous (0.40 – 0.55):</strong> Use this range to study variants where the AI prediction is uncertain.</li>
                        <li><strong>  Likely Pathogenic (0.85 – 1.00):</strong> Use this range to find mutations with a high probability of being detrimental.</li>
                    </ul>

                    <h4>Next Steps</h4>
                    <ul>
                        <li><strong>   CRISPR Oligo Design:</strong> Select a variant checkbox and click Generate Oligos. This provides oligo sequences for the Laughery et al. (2015) system (e.g., pML104 plasmid).</li>
                        <li><strong>   AI-assisted Experimental Plan:</strong> Use the Gemini feature to analyze the gene function, and assist in proposing a specific yeast functional assay given a user or AI selected phenotype.</li>
                    </ul>
                 </div>
             )}
        </div>

        {/* Controls */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex gap-4 mb-6 border-b border-slate-100 pb-2">
             <button 
                onClick={() => setInputMode('manual')}
                className={`pb-2 text-sm font-medium transition-colors ${inputMode === 'manual' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
             >
                Manual Input
             </button>
             <button 
                onClick={() => setInputMode('topic')}
                className={`pb-2 text-sm font-medium transition-colors ${inputMode === 'topic' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
             >
                Search by Topic
             </button>
          </div>

          {inputMode === 'manual' ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                <div className="md:col-span-1">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                    Human Gene Symbol
                </label>
                <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                    <input
                    type="text"
                    value={geneInput}
                    onChange={(e) => setGeneInput(e.target.value.toUpperCase())}
                    className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                    placeholder="e.g. ATP6V1B1"
                    />
                </div>
                </div>
                
                <div className="md:col-span-1">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                    Min AlphaMissense
                </label>
                <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={minScore}
                    onChange={(e) => setMinScore(parseFloat(e.target.value))}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
                </div>

                <div className="md:col-span-1">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                    Max AlphaMissense
                </label>
                <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={maxScore}
                    onChange={(e) => setMaxScore(parseFloat(e.target.value))}
                    className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
                </div>

                <button
                onClick={() => runPipeline()}
                disabled={state.step === 'searching' || state.step === 'aligning'}
                className="md:col-span-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-medium transition-all shadow-sm hover:shadow-md"
                >
                {state.step === 'searching' || state.step === 'aligning' ? (
                    <Activity className="w-4 h-4 animate-spin" />
                ) : (
                    <PlayCircle className="w-4 h-4" />
                )}
                Run Analysis
                </button>
            </div>
          ) : (
            <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="md:col-span-3 relative">
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                            Search Topic / Keyword
                        </label>
                        <Search className="absolute left-3 top-9 h-4 w-4 text-slate-500" />
                        <input
                            type="text"
                            value={topicInput}
                            onChange={(e) => setTopicInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleTopicSearch()}
                            className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-500"
                            placeholder="e.g. Cancer, Mitochondria, Deafness"
                        />
                    </div>
                    <div className="flex items-end gap-2">
                         <button
                            onClick={handleTopicSearch}
                            disabled={isSearchingTopic}
                            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded-lg font-medium disabled:opacity-50"
                         >
                            {isSearchingTopic ? <Activity className="w-4 h-4 animate-spin mx-auto" /> : "Find Genes"}
                         </button>
                         <button
                             onClick={handleFilterOrthologs}
                             disabled={isFilteringOrthologs || topicResults.length === 0}
                             className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-lg font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                         >
                             {isFilteringOrthologs ? <Activity className="w-4 h-4 animate-spin" /> : <Filter className="w-4 h-4" />}
                             Filter Orthologs
                         </button>
                    </div>
                </div>
                
                {/* Filter Inputs for Topic Mode */}
                <div className="grid grid-cols-2 gap-4 max-w-md">
                     <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                            Min AlphaMissense
                        </label>
                        <input
                            type="number"
                            step="0.01" min="0" max="1"
                            value={minScore} onChange={(e) => setMinScore(parseFloat(e.target.value))}
                            className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                        />
                     </div>
                     <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                            Max AlphaMissense
                        </label>
                        <input
                            type="number"
                            step="0.01" min="0" max="1"
                            value={maxScore} onChange={(e) => setMaxScore(parseFloat(e.target.value))}
                            className="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-400"
                        />
                     </div>
                </div>

                {topicResults.length > 0 && (
                    <div className="mt-4 border border-slate-200 rounded-lg max-h-60 overflow-y-auto bg-slate-50">
                        {topicResults.map((gene) => (
                            <div 
                                key={gene.entrez_id}
                                onClick={() => runPipeline(gene.entrez_id)}
                                className="px-4 py-3 border-b last:border-0 border-slate-100 hover:bg-indigo-50 cursor-pointer flex justify-between items-center group"
                            >
                                <div>
                                    <span className="font-bold text-slate-800">{gene.symbol}</span>
                                    <span className="text-slate-500 text-sm ml-2">- {gene.name}</span>
                                </div>
                                <div className="flex items-center gap-4">
                                    {gene.dioptScore !== undefined && (
                                        <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700 border border-green-200">
                                            DIOPT: {gene.dioptScore}
                                        </span>
                                    )}
                                    <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500" />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
          )}
        </div>

        {/* Status Logs */}
        <div className="bg-slate-900 rounded-xl shadow-inner p-4 font-mono text-xs max-h-60 overflow-y-auto border border-slate-800">
          {state.logs.length === 0 && <span className="text-slate-500">Ready to start...</span>}
          {state.logs.map((log, i) => (
            <div key={i} className={`mb-1 ${log.includes('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
              <span className="opacity-50 mr-2">{new Date().toLocaleTimeString()}</span>
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

        {geneInfo && ortholog && (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 animate-fade-in">
            {/* Left Column: Data & Viz */}
            <div className="lg:col-span-3 space-y-8">
              
              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-4">
                <a 
                    href={`https://www.uniprot.org/uniprotkb/${geneInfo.uniprot_id}/entry`} 
                    target="_blank" rel="noopener noreferrer"
                    className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all block relative"
                >
                  <ExternalLink className="w-4 h-4 text-slate-400 absolute top-4 right-4" />
                  <div className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-1">Human Gene</div>
                  <div className="text-xl font-bold text-slate-800">{geneInfo.symbol}</div>
                  <div className="text-sm text-slate-500 truncate">{geneInfo.name}</div>
                  <div className="mt-2 text-xs bg-slate-100 text-slate-600 inline-block px-2 py-1 rounded">
                    Entrez: {geneInfo.entrez_id}
                  </div>
                </a>

                <a 
                    href={`https://www.alliancegenome.org/gene/${ortholog.id.startsWith('SGD:') ? ortholog.id : 'SGD:' + ortholog.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all block relative"
                >
                  <ExternalLink className="w-4 h-4 text-slate-400 absolute top-4 right-4" />
                  <div className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-1">Yeast Ortholog</div>
                  <div className="text-xl font-bold text-emerald-700">{ortholog.symbol}</div>
                  <div className="text-sm text-slate-500">DIOPT Score: {ortholog.score}</div>
                  <div className="mt-2 text-xs bg-slate-100 text-slate-600 inline-block px-2 py-1 rounded">
                    ID: {ortholog.id}
                  </div>
                </a>
              </div>

              {/* Alignment Stats */}
              {alignment && (
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex gap-8 items-center justify-around">
                     <div className="text-center">
                         <div className="text-xs text-slate-500 uppercase font-semibold">Percent Identity</div>
                         <div className="text-2xl font-bold text-indigo-600">{alignment.percentIdentity?.toFixed(1)}%</div>
                     </div>
                     <div className="w-px h-10 bg-slate-200"></div>
                     <div className="text-center">
                         <div className="text-xs text-slate-500 uppercase font-semibold">Percent Similarity</div>
                         <div className="text-2xl font-bold text-emerald-600">{alignment.percentSimilarity?.toFixed(1)}%</div>
                     </div>
                </div>
              )}

              {/* Alignment View */}
              {alignment && (
                <AlignmentView 
                    humanSeq={alignment.humanSeqAligned}
                    yeastSeq={alignment.yeastSeqAligned}
                    variants={variants}
                    humanName={geneInfo.symbol}
                    yeastName={ortholog.symbol}
                    selectedResidue={selectedVariantIndex !== null ? variants[selectedVariantIndex].residue : null}
                />
              )}

              {/* Filtered Variants Table */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <List className="w-4 h-4" />
                    Filtered Variants
                  </h3>
                  <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2 py-1 rounded-full">
                    Showing Conserved Only
                  </span>
                </div>
                
                {/* Instructional Text */}
                <div className="px-6 py-2 bg-slate-50 text-xs text-slate-500 border-b border-slate-100 italic">
                    Click the Variant to see more detail. Click the AlphaMissense (AM) score to see more detail including the protein structure.
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium w-12">Select</th>
                        <th className="px-3 py-2 font-small">Variant</th>
                        <th className="px-3 py-2 font-small w-10">Ref</th>
                        <th className="px-3 py-2 font-small w-10">Var</th>
                        <th className="px-3 py-2 font-small">Status</th>
                        <th className="px-3 py-2 font-small w-10">Yeast AA</th>
                        <th className="px-3 py-2 font-small w-16">Yeast Pos</th>
                        <th className="px-3 py-3 font-small whitespace-nowrap">
                            <div className="relative group flex items-center gap-1 cursor-help">
                                AM Score
                                <HelpCircle className="w-3 h-3 text-slate-400" />
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-slate-900 text-white text-xs rounded shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                                    <p className="font-bold mb-1">AlphaMissense Predictions:</p>
                                    <ul className="list-disc pl-3 space-y-1 text-slate-300">
                                        <li>Likely Benign: &lt; 0.34</li>
                                        <li>Ambiguous: 0.34 – 0.56</li>
                                        <li>Likely Pathogenic: &gt; 0.56</li>
                                    </ul>
                                </div>
                            </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {variants.slice(0, visibleVariantsCount).map((v, i) => (
                        <tr 
                            key={i} 
                            className={`hover:bg-slate-50 transition-colors cursor-pointer ${selectedVariantIndex === i ? 'bg-indigo-50 hover:bg-indigo-100' : ''}`}
                            onClick={() => toggleVariantSelection(i)}
                        >
                          <td className="px-3 py-3 text-center">
                              <input 
                                type="checkbox" 
                                checked={selectedVariantIndex === i}
                                onChange={() => toggleVariantSelection(i)}
                                className="rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                              />
                          </td>
                          <td className="px-3 py-3 font-medium text-indigo-600 group relative">
                             {v.clinVarVariantId ? (
                                 <a 
                                    href={`https://www.ncbi.nlm.nih.gov/clinvar/variation/${v.clinVarVariantId}/`} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                    title={v.hgvs} // Tooltip for full name
                                 >
                                    {v.proteinChange}
                                    <ExternalLink className="w-3 h-3" />
                                 </a>
                             ) : v.proteinChange}
                          </td>
                          <td className="px-3 py-3 font-mono font-bold text-slate-900">{v.refAA}</td>
                          <td className="px-3 py-3 font-mono font-bold text-slate-900">{v.targetAA}</td>
                          <td className="px-3 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                              v.conservedStatus === 'Identical' ? 'bg-emerald-100 text-emerald-700' :
                              v.conservedStatus === 'Similar' ? 'bg-blue-100 text-blue-700' :
                              v.conservedStatus === 'Gap' ? 'bg-slate-100 text-slate-500' :
                              'bg-amber-100 text-amber-700'
                            }`}>
                              {v.conservedStatus}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-slate-900 font-mono font-bold">
                             {v.yeastAA}
                          </td>
                          <td className="px-3 py-3 text-slate-400 text-xs">
                             {v.yeastPos}
                          </td>
                          <td className="px-3 py-3 text-slate-900 whitespace-nowrap">
                             {v.amScore !== null ? (
                                 <a 
                                    href={`https://alphamissense.hegelab.org/hotspot?uid=${geneInfo.uniprot_id}&resi=${v.residue}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-indigo-600 hover:underline font-medium"
                                    onClick={(e) => e.stopPropagation()}
                                 >
                                    {v.amScore.toFixed(3)}
                                 </a>
                             ) : <span className="text-slate-400 italic">N/A</span>}
                          </td>
                        </tr>
                      ))}
                      {variants.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-6 py-8 text-center text-slate-500">
                            No variants found matching criteria.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {visibleVariantsCount < variants.length && (
                    <button 
                        onClick={handleShowMore}
                        className="w-full py-3 bg-slate-50 hover:bg-slate-100 text-indigo-600 font-medium text-sm transition-colors border-t border-slate-200"
                    >
                        Show 20 More ({variants.length - visibleVariantsCount} remaining)
                    </button>
                )}
              </div>

              {/* Phenotypes */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <div className="flex justify-between items-center mb-4">
                     <a 
                        href={`https://www.alliancegenome.org/gene/${ortholog.id.startsWith('SGD:') ? ortholog.id : 'SGD:' + ortholog.id}`}
                        target="_blank" rel="noopener noreferrer"
                        className="font-bold text-slate-800 flex items-center gap-2 hover:text-indigo-600 transition-colors"
                     >
                        <Activity className="w-4 h-4" />
                        Loss of Function Phenotypes
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                     </a>
                     <a 
                        href={`https://www.alliancegenome.org/gene/${ortholog.id.startsWith('SGD:') ? ortholog.id : 'SGD:' + ortholog.id}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
                     >
                        More Info <ExternalLink className="w-3 h-3" />
                     </a>
                </div>
                <p className="text-sm text-slate-500 mb-4">
                    Select a phenotype to tailor the AI experiment plan to it, or leave unselected to have the AI (Gemini) choose.
                </p>
                <div className="flex flex-wrap gap-2">
                  {phenotypes.length > 0 ? phenotypes.slice(0, 24).map((p, i) => (
                    <button 
                        key={i} 
                        onClick={() => togglePhenotypeSelection(p.phenotype)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            selectedPhenotype === p.phenotype 
                            ? 'bg-indigo-600 text-white border-indigo-700 shadow-sm' 
                            //? 'bg-indigo-600 text-white border-indigo-700 shadow-sm' 
                            : 'bg-amber-50 text-amber-800 border-amber-100 hover:bg-amber-100 hover:border-amber-200'
                        }`}
                    >
                      {p.phenotype}
                    </button>
                  )) : (
                    <span className="text-slate-400 text-sm italic">No specific phenotypes found.</span>
                  )}
                </div>
              </div>

            </div>

            {/* Right Column: Reports & AI */}
            <div className="lg:col-span-2 space-y-8">
              
              {/* CRISPR Oligo Design Card */}
              {selectedVariantIndex !== null && (
                <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-100 shadow-sm p-6 animate-fade-in relative overflow-hidden">
                    <div className="flex items-center gap-2 mb-4">
                        <FlaskConical className="w-5 h-5 text-emerald-600" />
                        <h3 className="font-bold text-emerald-900">
                           CRISPR Oligo Design (for <a href="https://www.addgene.org/67638/" target="_blank" rel="noopener noreferrer" className="underline hover:text-emerald-700">pML104</a>)
                        </h3>
                    </div>

                    {!isGeneratingCrispr && crisprResults.length === 0 && (
                        <div className="text-center py-6">
                            <p className="text-sm text-emerald-800 mb-4">
                                Generate CRISPR/Cas9 repair templates to introduce the <strong>{variants[selectedVariantIndex].targetAA}</strong> mutation from <strong>{variants[selectedVariantIndex].yeastAA}</strong> (<strong>{variants[selectedVariantIndex].yeastAA}{variants[selectedVariantIndex].yeastPos}{variants[selectedVariantIndex].targetAA}</strong>) at yeast position <strong>{variants[selectedVariantIndex].yeastPos}</strong> in yeast <strong>{ortholog.symbol}</strong>.
                            </p>
                            <button 
                                onClick={handleGenerateCrispr}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-sm transition-all flex items-center gap-2 mx-auto"
                            >
                                <Zap className="w-4 h-4" />
                                Generate Oligos for {variants[selectedVariantIndex].proteinChange}
                            </button>
                        </div>
                    )}

                    {isGeneratingCrispr && (
                        <div className="flex flex-col items-center justify-center py-10 text-emerald-800">
                             <Activity className="w-8 h-8 animate-spin mb-2" />
                             <span className="text-sm font-medium">Scanning yeast genome...</span>
                        </div>
                    )}

                    {crisprResults.length > 0 && (
                        <div className="space-y-6 text-sm">
                            {/* Guide Seq */}
                            <div className="bg-white/60 p-3 rounded border border-emerald-100">
                                <div className="flex justify-between items-center mb-1">
                                    <div className="flex items-center gap-2">
                                        <div className="text-xs font-bold text-emerald-800 uppercase">Guide Sequence + PAM (23nt)</div>
                                        {crisprResults[0].score !== undefined && (
                                            <a 
                                                href="https://www.nature.com/articles/nbt.3026" 
                                                target="_blank" rel="noopener noreferrer"
                                                title="Doench 2014 Efficiency Score (0-100)"
                                                className={`text-[10px] px-1.5 rounded border ${getScoreColor(crisprResults[0].score)}`}
                                            >
                                                Score: {crisprResults[0].score}
                                            </a>
                                        )}
                                    </div>
                                    <div className="flex gap-1">
                                        <button 
                                            onClick={() => copyToClipboard(crisprResults[0].guideSeqWithPam)}
                                            className="p-1 hover:bg-emerald-100 rounded text-emerald-600" title="Copy Guide"
                                        >
                                            <Copy className="w-3 h-3" />
                                        </button>
                                        <button 
                                            onClick={() => copyToClipboard(reverseComplement(crisprResults[0].guideSeqWithPam))}
                                            className="p-1 hover:bg-emerald-100 rounded text-emerald-600 text-[10px] font-bold" title="Copy Reverse Complement"
                                        >
                                            RC
                                        </button>
                                    </div>
                                </div>
                                <div className="font-mono text-slate-800 break-all">
                                    {renderGuideWithPam(crisprResults[0].guideSeqWithPam)}
                                </div>
                            </div>

                            {/* Repair Templates */}
                            <div className="space-y-3">
                                <div className="relative group">
                                    <div className="flex justify-between text-xs font-bold text-emerald-800 uppercase mb-1">
                                        Genomic Repair Template (Variant)
                                        <button onClick={() => copyToClipboard(crisprResults[0].repairTemplate)} className="text-emerald-600 hover:text-emerald-800"><Copy className="w-3 h-3"/></button>
                                    </div>
                                    <div className="font-mono text-xs text-slate-600 bg-white/60 p-2 rounded break-all border border-emerald-100">
                                        {crisprResults[0].repairTemplate}
                                    </div>
                                </div>
                                <div className="relative group">
                                    <div className="flex justify-between text-xs font-bold text-emerald-800 uppercase mb-1">
                                        Repair Template (Deletion Control)
                                        <button onClick={() => copyToClipboard(crisprResults[0].deletionRepairTemplate)} className="text-emerald-600 hover:text-emerald-800"><Copy className="w-3 h-3"/></button>
                                    </div>
                                    <div className="font-mono text-xs text-slate-600 bg-white/60 p-2 rounded break-all border border-emerald-100">
                                        {crisprResults[0].deletionRepairTemplate}
                                    </div>
                                </div>
                            </div>

                            {/* Verification */}
                            <div className="grid grid-cols-1 gap-4">
                                <div>
                                    <div className="text-xs font-bold text-emerald-800 uppercase mb-1">Verification (DNA)</div>
                                    <div className="bg-slate-900 text-slate-300 p-2 rounded font-mono text-[10px] overflow-x-auto whitespace-pre">
                                        <div className="flex"><span className="w-8 text-slate-500">REF:</span> {renderRefDna(crisprResults[0].dnaAlignment.original, crisprResults[0].site, crisprResults[0].homologyStart)}</div>
                                        <div className="flex"><span className="w-8 text-slate-500">VAR:</span> {renderAltSeq(crisprResults[0].dnaAlignment.original, crisprResults[0].dnaAlignment.modified)}</div>
                                        <div className="flex"><span className="w-8 text-slate-500">DEL:</span> {renderAltSeq(crisprResults[0].dnaAlignment.original, crisprResults[0].deletionDnaDisplay)}</div>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-xs font-bold text-emerald-800 uppercase mb-1">Verification (Protein)</div>
                                    <div className="bg-slate-900 text-slate-300 p-2 rounded font-mono text-[10px] overflow-x-auto whitespace-pre">
                                        <div className="flex"><span className="w-8 text-slate-500">REF:</span> {crisprResults[0].aaAlignment.original}</div>
                                        <div className="flex"><span className="w-8 text-slate-500">VAR:</span> {renderAltSeq(crisprResults[0].aaAlignment.original, crisprResults[0].aaAlignment.modified)}</div>
                                        <div className="flex"><span className="w-8 text-slate-500">DEL:</span> {renderAltSeq(crisprResults[0].aaAlignment.original, crisprResults[0].deletionProtein.substring(0, crisprResults[0].aaAlignment.original.length))}</div>
                                    </div>
                                </div>
                            </div>
                            
                            {/* Cloning Oligos */}
                            <div className="space-y-2 pt-2 border-t border-emerald-200/50">
                                <div className="relative group">
                                     <div className="flex justify-between text-xs font-bold text-emerald-800 uppercase">
                                        Cloning Oligo A (Forward)
                                        <button onClick={() => copyToClipboard(crisprResults[0].cloningOligoA)} className="text-emerald-600 hover:text-emerald-800"><Copy className="w-3 h-3"/></button>
                                     </div>
                                     <div className="font-mono text-xs text-slate-600 break-all">{crisprResults[0].cloningOligoA}</div>
                                </div>
                                <div className="relative group">
                                     <div className="flex justify-between text-xs font-bold text-emerald-800 uppercase">
                                        Cloning Oligo B (Reverse)
                                        <button onClick={() => copyToClipboard(crisprResults[0].cloningOligoB)} className="text-emerald-600 hover:text-emerald-800"><Copy className="w-3 h-3"/></button>
                                     </div>
                                     <div className="font-mono text-xs text-slate-600 break-all">{crisprResults[0].cloningOligoB}</div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
              )}

              {/* AI Report Card */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="w-5 h-5 text-indigo-600" />
                  <h3 className="font-bold text-slate-800">AI Experimental Plan</h3>
                </div>
                
                {!aiPlan && !isGeneratingAI && (
                    <div className="text-center py-8">
                        <p className="text-slate-700 text-sm mb-4">
                            Use Gemini to analyze the gene function, variants, and phenotypes to propose a CRISPR-based yeast assay.
                        </p>
                        <button 
                            onClick={handleGeneratePlan}
                            className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-6 py-2 rounded-lg font-medium shadow-sm transition-all flex items-center gap-2 mx-auto"
                        >
                            <Sparkles className="w-4 h-4" />
                            Generate AI-assisted Experimental Plan
                        </button>
                    </div>
                )}

                {isGeneratingAI && (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-500">
                    <Activity className="w-8 h-8 animate-spin text-indigo-600 mb-2" />
                    <span className="text-sm font-medium">Consulting Gemini...</span>
                  </div>
                )}

                {aiPlan && (
                  <div className="prose prose-sm prose-slate max-w-none prose-headings:font-bold prose-headings:text-slate-900 prose-p:text-slate-700 prose-li:text-slate-700 prose-hr:border-black prose-hr:border-t-2 text-slate-700">
                    <ReactMarkdown 
                        components={{
                            hr: ({node, ...props}) => <hr className="border-t-2 border-black my-4" {...props} />
                        }}
                    >
                        {aiPlan}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
              
              {/* PDF Export Button */}
              {aiPlan && (
                  <button 
                      onClick={handleExportPdf}
                      className="w-full py-3 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-medium shadow-sm transition-all flex items-center justify-center gap-2"
                  >
                      <Download className="w-4 h-4" />
                      Export Analysis Report (PDF)
                  </button>
              )}

            </div>
          </div>
        )}
      </main>
      
    </div>
  );
};
