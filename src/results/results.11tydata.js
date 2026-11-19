const proof = require('../_data/proof.json');
module.exports = { publishedCases: proof.cases.filter(c => c.published === true) };
