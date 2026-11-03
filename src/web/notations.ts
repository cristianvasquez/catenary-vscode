// The notation files (src/catenary/rdf/notations/*.ttl) in the in-memory file system, where catenary/rdf/notations.ts reads them. The
// web build defines import.meta.url as file:///catenary/ and bundles the files as text (catenary:notations). Imported before the shared code.
import notations from 'catenary:notations';
import { files } from './shims/fs';

for (const [name, text] of Object.entries(notations)) files.set(`/catenary/notations/${name}`, text);
