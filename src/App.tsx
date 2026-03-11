/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { 
  Upload, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Copy, 
  Trash2, 
  BarChart3,
  ShieldAlert,
  Search,
  Table as TableIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface DashboardEvaluation {
  fileName: string;
  problemUnderstanding: number;
  insightQuality: number;
  visualizationDesign: number;
  businessInterpretation: number;
  advancedAnalysis: number;
  finalScore: number;
  similarityScore: number;
  flag: 'OK' | 'CHECK' | 'POSSIBLE COPY';
  comments: string;
  layoutSummary: string; // Used for similarity comparison
  insightsSummary: string; // Used for similarity comparison
}

const RUBRIC_MAX = 5;
const TOTAL_MAX = 25;

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [evaluations, setEvaluations] = useState<DashboardEvaluation[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).filter((f: File) => f.type === 'application/pdf');
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const convertPdfToImage = async (file: File): Promise<string> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(1); // Evaluate the first page (usually the dashboard)
      
      const viewport = page.getViewport({ scale: 1.5 }); // Slightly lower scale for faster processing
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (!context) throw new Error('Could not get canvas context');
      
      await page.render({ canvasContext: context, viewport } as any).promise;
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]; // Use JPEG for smaller payload
    } catch (err: any) {
      console.error("PDF Conversion Error:", err);
      throw new Error(`Failed to process PDF: ${err.message}`);
    }
  };

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const callWithRetry = async (fn: () => Promise<any>, maxRetries = 3): Promise<any> => {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        // Check if it's a rate limit error (429)
        if (err.message?.includes('429') || err.status === 'RESOURCE_EXHAUSTED' || err.code === 429) {
          const waitTime = Math.pow(2, i) * 2000 + Math.random() * 1000;
          setStatus(`Rate limit reached. Retrying in ${Math.round(waitTime/1000)}s... (Attempt ${i + 1}/${maxRetries})`);
          await delay(waitTime);
          continue;
        }
        throw err; // Rethrow other errors immediately
      }
    }
    throw lastError;
  };

  const runEvaluation = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    setError(null);
    setEvaluations([]);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const model = "gemini-3-flash-preview"; // Faster model for better responsiveness
      
      const individualResults: any[] = [];

      // Step 1: Individual Evaluation
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Add a small delay between files to avoid hitting rate limits too quickly
        if (i > 0) {
          setStatus(`Waiting between files...`);
          await delay(1000);
        }

        setStatus(`[${i + 1}/${files.length}] Rendering PDF: ${file.name}...`);
        const base64Image = await convertPdfToImage(file);
        
        setStatus(`[${i + 1}/${files.length}] AI Analysis: ${file.name}...`);
        
        const prompt = `
          You are an expert professor in data analytics. Evaluate this student dashboard based on the following case and rubric.
          
          CASE:
          Students work as Data Analysts for a financial regulatory authority analyzing consumer complaints related to financial products (mortgages, credit cards, checking accounts, money transfers, credit reporting).
          Goal: Help senior management understand geographic concentration, high volume products/issues, response effectiveness, timeliness, and patterns across time/states.

          RUBRIC (0-5 each):
          1. Problem Understanding: Does it address business questions?
          2. Insight Quality: Meaningful insights revealed?
          3. Visualization Design: Clarity, layout, readability?
          4. Business Interpretation: Managerial implications?
          5. Advanced Analysis: Beyond basic requirements?

          Return the evaluation in JSON format:
          {
            "problemUnderstanding": number,
            "insightQuality": number,
            "visualizationDesign": number,
            "businessInterpretation": number,
            "advancedAnalysis": number,
            "comments": "string",
            "layoutSummary": "detailed description of layout and chart types used",
            "insightsSummary": "detailed description of specific insights and data points highlighted"
          }
        `;

        const result = await callWithRetry(async () => {
          const response = await ai.models.generateContent({
            model,
            contents: [
              {
                parts: [
                  { text: prompt },
                  { inlineData: { mimeType: "image/jpeg", data: base64Image } }
                ]
              }
            ],
            config: { responseMimeType: "application/json" }
          });
          return JSON.parse(response.text || '{}');
        });

        individualResults.push({ ...result, fileName: file.name });
      }

      // Step 2 & 3: Similarity Detection
      setStatus("Analyzing similarity across all dashboards...");
      await delay(1000); // Brief pause before similarity check
      
      const similarityPrompt = `
        Compare the following student dashboards for similarity in layout, chart types, insights, and structure.
        Assign a similarity score (0-100) for each dashboard relative to the others in the group.
        
        Dashboards Data:
        ${JSON.stringify(individualResults.map(r => ({
          fileName: r.fileName,
          layout: r.layoutSummary,
          insights: r.insightsSummary
        })))}

        Similarity interpretation:
        0–40 → different work
        40–70 → moderate similarity
        70–85 → high similarity
        85–100 → possible copying / academic integrity concern

        Return a JSON object mapping fileName to similarityScore:
        {
          "results": [
            { "fileName": "string", "similarityScore": number }
          ]
        }
      `;

      const similarityData = await callWithRetry(async () => {
        const similarityResponse = await ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: similarityPrompt }] }],
          config: { responseMimeType: "application/json" }
        });
        return JSON.parse(similarityResponse.text || '{"results":[]}');
      });
      const similarityMap = new Map(similarityData.results.map((r: any) => [r.fileName, r.similarityScore]));

      // Combine results
      const finalEvaluations: DashboardEvaluation[] = individualResults.map(r => {
        const simScore = (similarityMap.get(r.fileName) as number) || 0;
        const total = r.problemUnderstanding + r.insightQuality + r.visualizationDesign + r.businessInterpretation + r.advancedAnalysis;
        
        let flag: 'OK' | 'CHECK' | 'POSSIBLE COPY' = 'OK';
        if (simScore > 85) flag = 'POSSIBLE COPY';
        else if (simScore >= 70) flag = 'CHECK';

        return {
          ...r,
          finalScore: total,
          similarityScore: simScore,
          flag,
        };
      });

      setEvaluations(finalEvaluations);
      setStatus("Evaluation complete.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred during evaluation.");
    } finally {
      setIsProcessing(false);
    }
  };

  const copyToClipboard = () => {
    const header = "File Name | Problem Understanding | Insight Quality | Visualization Design | Business Interpretation | Advanced Analysis | Final Score | Similarity Score | Flag | Comments";
    const rows = evaluations.map(e => 
      `${e.fileName} | ${e.problemUnderstanding} | ${e.insightQuality} | ${e.visualizationDesign} | ${e.businessInterpretation} | ${e.advancedAnalysis} | ${e.finalScore} | ${e.similarityScore} | ${e.flag} | ${e.comments}`
    ).join('\n');
    
    navigator.clipboard.writeText(header + '\n' + rows);
    alert("Table copied to clipboard in Excel-ready format!");
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans p-6 md:p-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="mb-12">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-indigo-600 rounded-lg text-white">
              <BarChart3 size={24} />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">
              Professor's Dashboard Evaluator
            </h1>
          </div>
          <p className="text-slate-500 max-w-2xl">
            Automated grading and academic integrity check for student Tableau/Power BI dashboards. 
            Upload PDF exports to begin the evaluation process.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Upload & Controls */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Upload size={20} className="text-indigo-600" />
                Upload Dashboards
              </h2>
              
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center hover:border-indigo-400 hover:bg-indigo-50/30 transition-all cursor-pointer group"
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  multiple 
                  accept=".pdf" 
                  className="hidden" 
                />
                <div className="flex flex-col items-center">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3 group-hover:bg-indigo-100 transition-colors">
                    <FileText className="text-slate-400 group-hover:text-indigo-600" />
                  </div>
                  <p className="text-sm font-medium text-slate-700">Click to upload PDFs</p>
                  <p className="text-xs text-slate-400 mt-1">Select multiple student files</p>
                </div>
              </div>

              {files.length > 0 && (
                <div className="mt-6 space-y-2 max-h-60 overflow-y-auto pr-2">
                  <AnimatePresence>
                    {files.map((file, idx) => (
                      <motion.div 
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        key={`${file.name}-${idx}`}
                        className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText size={16} className="text-indigo-500 shrink-0" />
                          <span className="text-xs font-medium truncate">{file.name}</span>
                        </div>
                        <button 
                          onClick={() => removeFile(idx)}
                          className="text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}

              <button
                disabled={files.length === 0 || isProcessing}
                onClick={runEvaluation}
                className={`w-full mt-6 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all ${
                  files.length === 0 || isProcessing
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
                }`}
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={18} />
                    Evaluate All
                  </>
                )}
              </button>
            </div>

            {/* Status & Errors */}
            {(status || error) && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-4 rounded-xl border flex gap-3 ${
                  error ? 'bg-red-50 border-red-100 text-red-700' : 'bg-indigo-50 border-indigo-100 text-indigo-700'
                }`}
              >
                {error ? <AlertCircle size={20} className="shrink-0" /> : <Loader2 size={20} className="shrink-0 animate-spin" />}
                <p className="text-sm font-medium">{error || status}</p>
              </motion.div>
            )}
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden min-h-[400px]">
              <div className="p-6 border-bottom border-slate-100 flex items-center justify-between bg-slate-50/50">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <TableIcon size={20} className="text-indigo-600" />
                  Evaluation Results
                </h2>
                {evaluations.length > 0 && (
                  <button 
                    onClick={copyToClipboard}
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm"
                  >
                    <Copy size={16} />
                    Copy for Excel
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                {evaluations.length > 0 ? (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50/50 text-slate-500 text-[10px] uppercase tracking-wider font-bold">
                        <th className="px-6 py-4 border-b border-slate-100">File Name</th>
                        <th className="px-4 py-4 border-b border-slate-100 text-center">Score (25)</th>
                        <th className="px-4 py-4 border-b border-slate-100 text-center">Similarity</th>
                        <th className="px-4 py-4 border-b border-slate-100 text-center">Flag</th>
                        <th className="px-6 py-4 border-b border-slate-100">Comments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {evaluations.map((e, idx) => (
                        <motion.tr 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: idx * 0.05 }}
                          key={e.fileName} 
                          className="hover:bg-slate-50/50 transition-colors"
                        >
                          <td className="px-6 py-4 text-xs font-semibold text-slate-700">{e.fileName}</td>
                          <td className="px-4 py-4 text-center">
                            <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full font-bold text-sm ${
                              e.finalScore >= 20 ? 'bg-emerald-50 text-emerald-700' : 
                              e.finalScore >= 15 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'
                            }`}>
                              {e.finalScore}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-center">
                            <div className="flex flex-col items-center gap-1">
                              <span className="text-xs font-mono font-bold">{e.similarityScore}%</span>
                              <div className="w-16 h-1 bg-slate-100 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full rounded-full ${
                                    e.similarityScore > 85 ? 'bg-red-500' : 
                                    e.similarityScore >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                                  }`}
                                  style={{ width: `${e.similarityScore}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${
                              e.flag === 'OK' ? 'bg-emerald-100 text-emerald-700' :
                              e.flag === 'CHECK' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {e.flag}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-3 hover:line-clamp-none transition-all cursor-default">
                              {e.comments}
                            </p>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <Search size={48} strokeWidth={1} className="mb-4 opacity-20" />
                    <p className="text-sm">No evaluations yet. Upload files and click "Evaluate All".</p>
                  </div>
                )}
              </div>
            </div>

            {/* Rubric Reference */}
            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-indigo-50/50 rounded-xl border border-indigo-100">
                <h3 className="text-xs font-bold text-indigo-900 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <ShieldAlert size={14} />
                  Similarity Interpretation
                </h3>
                <ul className="space-y-2 text-[11px] text-indigo-800">
                  <li className="flex justify-between"><span>0–40%</span> <span className="font-bold">Different Work (OK)</span></li>
                  <li className="flex justify-between"><span>40–70%</span> <span className="font-bold">Moderate Similarity (OK)</span></li>
                  <li className="flex justify-between"><span>70–85%</span> <span className="font-bold">High Similarity (CHECK)</span></li>
                  <li className="flex justify-between"><span>85–100%</span> <span className="font-bold">Possible Copy (POSSIBLE COPY)</span></li>
                </ul>
              </div>
              <div className="p-4 bg-slate-100 rounded-xl border border-slate-200">
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">Rubric Breakdown</h3>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  1. Problem Understanding (5) • 2. Insight Quality (5) • 3. Visualization Design (5) • 4. Business Interpretation (5) • 5. Advanced Analysis (5)
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
