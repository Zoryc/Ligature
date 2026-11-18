-- Writes an uncompressed stream object of @PDF_MB@ MiB straight into the PDF.
pdf.setcompresslevel(0)
local mib = string.rep("0123456789abcdef", 65536)
pdf.immediateobj("stream", string.rep(mib, @PDF_MB@))
texio.write_nl("term and log", "CORPUS-PROBE big-object: written")
