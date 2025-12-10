import { GoogleGenAI } from "@google/genai";
import { AnalyzedVariant, GeneInfo, OrthologInfo } from '../types';
import { AA_MAP_1_TO_3 } from "../utils/alignment";

export const generateClinicalInterpretation = async (
  humanGene: GeneInfo,
  ortholog: OrthologInfo,
  variant: AnalyzedVariant,
  clinicalNotes?: string
): Promise<string> => {
  
  const ref3 = AA_MAP_1_TO_3[variant.refAA] || variant.refAA;
  const target3 = AA_MAP_1_TO_3[variant.targetAA] || variant.targetAA;
  const formattedVariant = `p.${ref3}${variant.residueIndex}${target3}`;

  const prompt = `
    You are an expert Clinical Geneticist and Molecular Biologist acting as a consultant for a clinician.
    
    Review the following Variant of Unknown Significance (VUS) analysis:

    **Human Gene:** ${humanGene.symbol} (${humanGene.name})
    **Variant:** ${formattedVariant}
    
    **Yeast Ortholog:** ${ortholog.symbol} (DIOPT Score: ${ortholog.score})
    **Conservation Analysis:**
    - Human Residue: ${variant.refAA} at position ${variant.residueIndex}
    - Yeast Residue: ${variant.yeastAA_Aligned} at alignment position ${variant.yeastPos}
    - Status: ${variant.conservationStatus}
    
    ${variant.alphaMissenseScore ? `**AlphaMissense Score:** ${variant.alphaMissenseScore} (High scores > 0.56 indicate probable pathogenicity)` : ''}
    ${variant.gnomadFrequency ? `**gnomAD Frequency:** ${variant.gnomadFrequency.toExponential(2)}` : ''}
    ${variant.clinVarSignificance ? `**ClinVar Status:** ${variant.clinVarSignificance}` : ''}
    
    **Clinician Notes:** ${clinicalNotes || "None provided."}

    **Task:**
    Write a professional Clinical Interpretation writeup (approx. 200 words) tailored for a medical doctor.
    
    **Required Structure:**
    1. **Clinical Gene Profile:** Briefly describe the gene's primary function, mentioning relevant isoforms, key organ systems involved (e.g., renal, cardiac), and established disease associations (e.g., "associated with autosomal recessive distal RTA").
    2. **Biochemical & Structural Analysis:** Briefly analyze the specific amino acid change (${variant.refAA} to ${variant.targetAA}). Explain the biochemical impact in clear simple terms (e.g., "Replacing a positively charged Arginine with a neutral Glutamine may disrupt protein stability").
    3. **Evolutionary Insight:** Interpret the conservation data. If the residue is conserved in yeast (${ortholog.symbol}), emphasize its likely critical role across evolution.
    4. **Synthesis & Recommendation:** Integrate the population frequency (gnomAD) and predictive scores to assess likelihood of pathogenicity. Conclude on the specific value of pursuing functional modeling in yeast for this variant.
    
    **Format:**
    - Professional, concise medical tone.
    - Use Markdown.
    - Avoid generic statements; be specific to this gene and variant.
  `;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "No interpretation generated.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return `Error generating interpretation: ${(error as Error).message}`;
  }
};

export const generatePatientReport = async (
  humanGene: GeneInfo,
  variant: AnalyzedVariant
): Promise<string> => {
    const ref3 = AA_MAP_1_TO_3[variant.refAA] || variant.refAA;
    const target3 = AA_MAP_1_TO_3[variant.targetAA] || variant.targetAA;
    const formattedVariant = `p.${ref3}${variant.residueIndex}${target3}`;

    const prompt = `
    Write a "Patient-Friendly" summary for a genetic test report.
    Target audience: A patient with a 5th-grade reading level. 
    Tone: Empathetic, clear, and reassuring. Avoid jargon.

    Data:
    - Gene: ${humanGene.symbol} (${humanGene.name})
    - Variant: ${formattedVariant}
    - Frequency: ${variant.gnomadFrequency ? (variant.gnomadFrequency < 0.001 ? 'Very Rare' : 'Common') : 'Unknown'}
    - Prediction: ${variant.alphaMissenseScore && variant.alphaMissenseScore > 0.56 ? 'Computer models suggest this might affect how the gene works' : 'Computer models are unsure'}
    
    Structure:
    1. What is this gene? (One simple sentence about what it does).
    2. What was found? (Explain the "spelling change" in simple terms).
    3. Is it rare? (Explain simply).
    4. What does it mean? (Explain that "Unknown Significance" means we are still learning, and that scientists and doctors might be able to check if it looks similar in other living things like yeast to understand it better).
    
    Do NOT give medical advice. Keep it under 150 words.
    `;

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        return response.text || "Summary not available.";
      } catch (error) {
        return "Could not generate patient summary.";
      }
};