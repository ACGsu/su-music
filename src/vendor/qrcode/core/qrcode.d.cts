export function create(text: string | { data: string; mode: 'byte' }[], options?: { errorCorrectionLevel?: 'L'|'M'|'Q'|'H' }): { modules: { size:number; data:Uint8Array } }
