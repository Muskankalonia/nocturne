-- =============================================================================
-- Nocturne Pipeline: Step 3 - Layer 0: Regex Indicator Detection UDF
-- =============================================================================
-- A JavaScript UDF that scans raw_text with regex patterns for data security
-- indicators: PII, financial, network/IOC, vulnerability, and credentials.
-- Returns matched values in "type = value" format, one per line.
-- =============================================================================

USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE FUNCTION NOCTURNE.RAW.DETECT_INDICATORS(text STRING)
RETURNS STRING
LANGUAGE JAVASCRIPT
AS
$$
  if (!TEXT) return '';

  var patterns = {
    // --- PII ---
    'ssn':              /\b\d{3}-\d{2}-\d{4}\b/g,
    'email':            /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    'phone':            /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    'drivers_license':  /\b[A-Z]\d{7,12}\b/g,

    // --- Financial ---
    'credit_card':      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
    'bitcoin_wallet':   /\b(?:1|3|bc1)[A-Za-z0-9]{25,42}\b/g,
    'ethereum_wallet':  /\b0x[a-fA-F0-9]{40}\b/g,
    'monero_wallet':    /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/g,

    // --- Network / IOC ---
    'ipv4':             /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    'ipv6':             /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    'onion_url':        /\b[a-z2-7]{16,56}\.onion\b/g,
    'domain':           /\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|xyz|ru|cc|to)\b/gi,

    // --- Vulnerability / Malware ---
    'cve':              /\bCVE-\d{4}-\d{4,}\b/gi,
    'md5_hash':         /\b[a-fA-F0-9]{32}\b/g,
    'sha256_hash':      /\b[a-fA-F0-9]{64}\b/g,

    // --- Credentials / Secrets ---
    'api_key':          /\b(?:api[_\-]?key|apikey|token)[=:\s]+['"]?[A-Za-z0-9\-_]{20,}['"]?\b/gi,
    'password_leak':    /\b(?:password|passwd|pwd)[=:\s]+[^\s]{4,}\b/gi
  };

  var results = [];
  for (var name in patterns) {
    var matches = TEXT.match(patterns[name]);
    if (matches) {
      // Deduplicate and cap at 10 per indicator type
      var unique = matches.filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 10);
      for (var i = 0; i < unique.length; i++) {
        results.push(name + ' = ' + unique[i]);
      }
    }
  }
  return results.length > 0 ? results.join('\n') : '';
$$;

-- Test the UDF
-- SELECT NOCTURNE.RAW.DETECT_INDICATORS('Contact seller at dark@market.onion, BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa, CVE-2024-1234');
