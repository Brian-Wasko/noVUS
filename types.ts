

export interface GeneInfo {
  symbol: string;
  name: string;
  entrez_id: string;
  ensembl_id?: string; // Added for gnomAD links
  uniprot_id: string | null;
}

export interface OrthologInfo {
  id: string; // SGD ID or Symbol
  symbol: string;
  score: number;
}

export interface SequenceRecord {
  id: string;
  description: string;
  seq: string;
}

export interface AlignmentResult {
  humanSeqAligned: string;
  yeastSeqAligned: string;
  score: number;
  percentIdentity?: number;
  percentSimilarity?: number;
}

// New interface for the single-variant clinical workflow
export interface AnalyzedVariant {
  originalInput: string;
  residueIndex: number; // 1-based
  refAA: string; // 1-letter
  targetAA: string; // 1-letter
  humanAA_Aligned: string;
  yeastAA_Aligned: string;
  conservationStatus: 'Identical' | 'Similar' | 'Mismatch' | 'Gap' | 'N/A';
  yeastPos: number;
  
  // Predictions & Database
  alphaMissenseScore?: number;
  clinVarSignificance?: string;
  clinVarId?: string;
  gnomadFrequency?: number; // Population frequency (0-1)
  
  // AI Generated Content
  clinicalInterpretation?: string;
  patientSummary?: string;
}

export interface PipelineState {
  step: 'idle' | 'analyzing' | 'complete' | 'error';
  error?: string;
  logs: string[];
}

export interface ClinicalInput {
  gene: string;
  variant: string;
  panel: string;
  notes: string;
}

export type VirtualPanel = 'None' | 'Cardiomyopathy' | 'Nephrology' | 'Epilepsy' | 'Oncology' | 'Connective Tissue';

// Legacy/Shared Types needed for API services
export interface Variant {
  hgvs: string;
  proteinChange: string;
  residue: number;
  refAA: string;
  targetAA: string;
  conservedStatus: 'Identical' | 'Similar' | 'Mismatch' | 'Gap' | 'N/A';
  yeastAA: string;
  yeastPos: string;
  amScore: number | null;
  clinVarId?: string;
  clinVarVariantId?: string;
}

export interface Phenotype {
  phenotype: string;
}

export interface Cas9Site {
  position: number;
  sequence: string;
  strand: 'forward' | 'reverse';
  context30?: string;
}

export interface AlignmentData {
  original: string;
  modified: string;
  matchString: string;
}

export interface RepairResult {
  site: Cas9Site;
  cloningOligoA: string;
  cloningOligoB: string;
  repairTemplate: string;
  guideSeqWithPam: string;
  score?: number;
  deletionRepairTemplate: string;
  deletionDnaDisplay: string;
  deletionProtein: string;
  originalRegion: string;
  homologyStart: number;
  mutationPosition: number;
  aaChangeStatus: string;
  aaChangesCount: number;
  dnaAlignment: AlignmentData;
  aaAlignment: AlignmentData;
  strategy: string;
  silentMutationCount: number;
}

export type CodonTable = Record<string, string[]>;