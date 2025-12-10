
import { GeneInfo, OrthologInfo, SequenceRecord, Variant, Phenotype } from '../types';
import { AA_MAP, parseProteinChange, isSimilarAA, AA_MAP_1_TO_3 } from '../utils/alignment';

// --- MyGene.info ---
export const getHumanGeneInfo = async (symbol: string): Promise<GeneInfo> => {
  // If input is all digits, treat as Entrez ID
  const isEntrezId = /^\d+$/.test(symbol);
  let url = `https://mygene.info/v3/query?q=${symbol}&scopes=symbol,alias&fields=symbol,entrezgene,name,uniprot,ensembl,type_of_gene&species=human`;
  
  if (isEntrezId) {
    url = `https://mygene.info/v3/gene/${symbol}?fields=symbol,entrezgene,name,uniprot,ensembl,type_of_gene`;
  }

  const response = await fetch(url);
  const data = await response.json();
  
  let hit;
  if (isEntrezId) {
    hit = data;
  } else {
    if (!data.hits || data.hits.length === 0) {
      throw new Error("Gene not found in MyGene.info");
    }
    hit = data.hits[0];
  }

  // Check if protein coding
  if (hit.type_of_gene && hit.type_of_gene !== 'protein-coding') {
     throw new Error(`Gene '${hit.symbol}' is ${hit.type_of_gene}, not protein-coding. No UniProt ID available.`);
  }

  let uniprotId = null;
  if (hit.uniprot) {
    if (typeof hit.uniprot === 'string') uniprotId = hit.uniprot;
    else if (hit.uniprot['Swiss-Prot']) uniprotId = Array.isArray(hit.uniprot['Swiss-Prot']) ? hit.uniprot['Swiss-Prot'][0] : hit.uniprot['Swiss-Prot'];
  }

  // Extract Ensembl ID for gnomAD links
  let ensemblId = undefined;
  if (hit.ensembl) {
    if (Array.isArray(hit.ensembl)) {
        ensemblId = hit.ensembl[0].gene;
    } else {
        ensemblId = hit.ensembl.gene;
    }
  }

  return {
    symbol: hit.symbol,
    name: hit.name,
    entrez_id: hit.entrezgene?.toString(),
    ensembl_id: ensemblId,
    uniprot_id: uniprotId
  };
};

export const searchHumanGenes = async (term: string): Promise<{ symbol: string; name: string; entrez_id: string }[]> => {
  // Query for human genes matching the term, limiting to top 50, strictly protein-coding to ensure UniProt IDs
  const response = await fetch(`https://mygene.info/v3/query?q=${encodeURIComponent(term)}%20AND%20type_of_gene:protein-coding&species=human&size=50&fields=symbol,name,entrezgene,uniprot`);
  const data = await response.json();
  
  if (!data.hits || data.hits.length === 0) {
    return [];
  }

  return data.hits.map((hit: any) => ({
    symbol: hit.symbol,
    name: hit.name || 'Unknown Name',
    entrez_id: hit.entrezgene?.toString(),
    hasUniprot: !!hit.uniprot // Helper to filter
  }))
  .filter((g: any) => g.symbol && g.hasUniprot); // Ensure symbol exists and has uniprot (proxy for being analyzable)
};

// --- DIOPT ---
export const getOrtholog = async (entrezId: string): Promise<OrthologInfo | null> => {
  const targetUrl = `https://www.flyrnai.org/tools/diopt/web/diopt_api/v9/get_orthologs_from_entrez/9606/${entrezId}/4932/best_match`;

  // Helper to parse DIOPT response structure (which can be nested in different ways)
  const processDioptData = (data: any): OrthologInfo | null => {
    const resultsContainer = data.results || {};
    
    // Try exact Entrez ID match first (both string and number keys)
    let orthologEntries = resultsContainer[entrezId] || resultsContainer[Number(entrezId)];

    // Fallback: If not found by exact key, use the first key in the object
    if (!orthologEntries) {
      const keys = Object.keys(resultsContainer);
      if (keys.length > 0) {
        orthologEntries = resultsContainer[keys[0]];
      }
    }

    if (!orthologEntries) {
        console.warn("DIOPT: No ortholog entries found in parsed results.", Object.keys(resultsContainer));
        return null;
    }

    let bestHit: any = null;
    let bestScore = -1;

    // Iterate over entries to find the highest score
    Object.values(orthologEntries).forEach((entry: any) => {
      if (entry && typeof entry === 'object' && 'score' in entry) {
        const score = entry.score || 0;
        if (score > bestScore) {
          bestScore = score;
          bestHit = entry;
        }
      }
    });

    if (bestHit) {
      const yeastId = bestHit.species_specific_geneid || bestHit.symbol;
      return {
        id: yeastId,
        symbol: bestHit.symbol,
        score: bestScore
      };
    }
    return null;
  };

  try {
    const response = await fetch(targetUrl);
    if (response.ok) {
      const data = await response.json();
      const result = processDioptData(data);
      if (result) return result;
    }
  } catch (e) {
    console.warn("DIOPT Direct fetch failed (likely CORS), trying proxy...", e);
  }

  try {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl);
    if (response.ok) {
        const data = await response.json();
        const result = processDioptData(data);
        if (result) return result;
    }
  } catch (e) {
      console.warn("CorsProxy failed", e);
  }

  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl);
    if (response.ok) {
      const wrapper = await response.json();
      if (wrapper.contents) {
        const data = JSON.parse(wrapper.contents);
        const result = processDioptData(data);
        if (result) return result;
      }
    }
  } catch (e) {
    console.warn("DIOPT AllOrigins fetch failed", e);
  }

  return null;
};

// --- Ensembl (Yeast DNA Sequence) ---
export const fetchYeastGeneSequence = async (geneSymbol: string): Promise<string> => {
    const ENSEMBL_BASE = "https://rest.ensembl.org";
    
    // 1. Resolve Symbol to ID
    const xrefResponse = await fetch(
      `${ENSEMBL_BASE}/xrefs/symbol/saccharomyces_cerevisiae/${geneSymbol}?content-type=application/json`
    );
    if (!xrefResponse.ok) throw new Error("Yeast gene symbol lookup failed in Ensembl");
    const xrefData = await xrefResponse.json();
    if (!xrefData.length) throw new Error(`Gene '${geneSymbol}' not found in Yeast Ensembl database.`);
  
    const id = xrefData[0].id;
  
    // 2. Get Sequence
    const seqResponse = await fetch(
      `${ENSEMBL_BASE}/sequence/id/${id}?content-type=text/plain`
    );
    if (!seqResponse.ok) throw new Error("Yeast sequence lookup failed");
    const sequence = await seqResponse.text();
    return sequence.trim();
};

// --- UniProt ---
export const fetchSequence = async (id: string, isYeast = false): Promise<SequenceRecord> => {
  let url = `https://rest.uniprot.org/uniprotkb/${id}.fasta`;
  
  if (isYeast) {
    const isSgdId = id.startsWith('SGD:') || /^S\d+$/.test(id);
    if (isSgdId) {
      const cleanId = id.replace('SGD:', '').trim();
      url = `https://rest.uniprot.org/uniprotkb/search?query=xref:sgd-${cleanId}&format=fasta&size=1`;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch sequence for ${id} (Status: ${response.status})`);
  }
  
  const text = await response.text();
  if (!text || !text.trim()) {
     throw new Error(`No sequence data returned for ${id}`);
  }

  const lines = text.trim().split('\n');
  const description = lines[0];
  const seq = lines.slice(1).join('').trim();
  
  return { id, description, seq };
};

// --- MyVariant.info (Specific Variant Fetch) ---
// Fetches data for a SPECIFIC variant to ensure we get the correct record.
export const fetchSpecificVariantData = async (geneSymbol: string, ref: string, res: number, target: string, rawVariant?: string): Promise<any | null> => {
    // Convert 1-letter codes to 3-letter codes for querying (e.g., R -> Arg)
    const ref3 = AA_MAP_1_TO_3[ref] || ref;
    const target3 = AA_MAP_1_TO_3[target] || target;
    
    // Construct variant string, e.g., "p.Arg114Gln"
    const queryParts: string[] = [];

    if (res > 0) {
        const proteinChange = `p.${ref3}${res}${target3}`;
        const proteinChangeShort = `p.${ref}${res}${target}`;
        queryParts.push(`"${proteinChange}"`);
        queryParts.push(`"${proteinChangeShort}"`);
    }

    if (rawVariant) {
        queryParts.push(`"${rawVariant}"`);
    }

    if (queryParts.length === 0) {
        // Fallback or error if no valid variant definition
        // If we only have gene, we return null as this is specific variant fetch
        return null;
    }

    const variantQuery = queryParts.join(" OR ");
    
    // Query Logic:
    // Broaden search: Search by Gene Symbol AND (Protein Change string match)
    // We search across all fields but filter results in code if needed.
    const query = `q=${geneSymbol} AND (${variantQuery})&fields=clinvar,gnomad_exome,gnomad_genome,dbnsfp,snpeff`;
    const url = `https://myvariant.info/v1/query?${query}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.hits && data.hits.length > 0) {
            // Sort hits to find the most informative one.
            // MyVariant might return multiple records (e.g., different genomic builds or separate sources).
            // We prioritize records that have gnomAD or ClinVar data.
            const sortedHits = data.hits.sort((a: any, b: any) => {
                let scoreA = 0;
                if (a.gnomad_exome || a.gnomad_genome) scoreA += 3;
                if (a.clinvar) scoreA += 2;
                if (a.dbnsfp) scoreA += 1;

                let scoreB = 0;
                if (b.gnomad_exome || b.gnomad_genome) scoreB += 3;
                if (b.clinvar) scoreB += 2;
                if (b.dbnsfp) scoreB += 1;
                
                return scoreB - scoreA;
            });

            return sortedHits[0];
        }
        return null;
    } catch (e) {
        console.warn("Variant fetch failed", e);
        return null;
    }
};

// --- Yeast Phenotypes ---
export const fetchYeastPhenotypes = async (yeastId: string): Promise<Phenotype[]> => {
  const agrId = yeastId.startsWith('SGD:') ? yeastId : `SGD:${yeastId}`;
  const url = `https://www.alliancegenome.org/api/gene/${agrId}/phenotypes?limit=50`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    
    const data = await response.json();
    const results = data.results || [];
    
    return results
      .map((r: any) => ({ phenotype: r.phenotypeStatement }))
      .filter((p: Phenotype) => /null|deletion|loss|decreased/i.test(p.phenotype));
  } catch (e) {
    console.warn("Phenotype fetch failed", e);
    return [];
  }
};
