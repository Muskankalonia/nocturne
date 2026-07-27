-- =============================================================================
-- Nocturne Pipeline: Step 4 - Layer 0 Structured Indicator Detection
-- =============================================================================
-- Scans raw text for deterministic leak and security indicators. This layer is
-- target-agnostic: a valid secret or card is evidence, not proof that the data
-- belongs to the monitored organization.
--
-- The returned VARIANT contains:
--   matches: type, value, start/end span, strength, validity, truncation status
--   counts: unique retained matches by type (maximum 10 per type)
--   summary_text: compact nonzero counts for L1
--   strong_count, medium_count, weak_count, evidence_score
--
-- "validity = true" means syntactically valid, not confirmed active or genuine.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE FUNCTION NOCTURNE.RAW.DETECT_INDICATORS(text STRING)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
IMMUTABLE
AS
$$
  var MAX_MATCHES_PER_TYPE = 10;
  var MAX_SCANNED_MATCHES_PER_PATTERN = 100;
  var MAX_VALUE_LENGTH = 512;

  function emptyResult() {
    return {
      matches: [],
      counts: {},
      summary_text: '',
      strong_count: 0,
      medium_count: 0,
      weak_count: 0,
      evidence_score: 0
    };
  }

  if (!TEXT) {
    return emptyResult();
  }

  var result = emptyResult();
  var seenByType = Object.create(null);

  function strengthRank(strength) {
    if (strength === 'strong') {
      return 3;
    }
    if (strength === 'medium') {
      return 2;
    }
    return 1;
  }

  function addMatch(type, rawValue, start, strength, validity) {
    if (!seenByType[type]) {
      seenByType[type] = Object.create(null);
    }
    if (result.counts[type] >= MAX_MATCHES_PER_TYPE) {
      return false;
    }

    var dedupeValue = String(rawValue);
    if (seenByType[type][dedupeValue]) {
      return true;
    }

    var end = start + dedupeValue.length;
    for (var existingIndex = 0; existingIndex < result.matches.length; existingIndex += 1) {
      var existing = result.matches[existingIndex];
      var overlaps = start < existing.end && existing.start < end;
      if (
        overlaps
        && strengthRank(existing.strength) > strengthRank(strength)
      ) {
        return true;
      }
    }
    seenByType[type][dedupeValue] = true;

    var truncated = dedupeValue.length > MAX_VALUE_LENGTH;
    var storedValue = truncated
      ? dedupeValue.slice(0, MAX_VALUE_LENGTH)
      : dedupeValue;

    result.matches.push({
      type: type,
      value: storedValue,
      start: start,
      end: end,
      strength: strength,
      validity: validity,
      truncated: truncated
    });
    result.counts[type] = (result.counts[type] || 0) + 1;

    if (strength === 'strong') {
      result.strong_count += 1;
    } else if (strength === 'medium') {
      result.medium_count += 1;
    } else {
      result.weak_count += 1;
    }
    return true;
  }

  function scan(type, regex, strength, validity) {
    var match;
    var scannedMatches = 0;
    regex.lastIndex = 0;
    while ((match = regex.exec(TEXT)) !== null) {
      scannedMatches += 1;
      if (!addMatch(type, match[0], match.index, strength, validity)) {
        break;
      }
      if (scannedMatches >= MAX_SCANNED_MATCHES_PER_PATTERN) {
        break;
      }
    }
  }

  function passesLuhn(value) {
    var digits = value.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return false;
    }
    if (/^(\d)\1+$/.test(digits)) {
      return false;
    }

    var sum = 0;
    var doubleDigit = false;
    for (var index = digits.length - 1; index >= 0; index -= 1) {
      var digit = parseInt(digits.charAt(index), 10);
      if (doubleDigit) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      sum += digit;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  }

  // Credit-card candidates are retained even when Luhn fails, but invalid
  // candidates are weak evidence and cannot drive a strong leak signal.
  var cardPattern = /\b(?:\d[ -]?){12,18}\d\b/g;
  var cardMatch;
  var cardCandidatesScanned = 0;
  while ((cardMatch = cardPattern.exec(TEXT)) !== null) {
    cardCandidatesScanned += 1;
    var cardIsValid = passesLuhn(cardMatch[0]);
    var cardType = cardIsValid
      ? 'validated_credit_card'
      : 'invalid_credit_card_candidate';
    var cardStrength = cardIsValid ? 'strong' : 'weak';
    addMatch(
      cardType,
      cardMatch[0],
      cardMatch.index,
      cardStrength,
      cardIsValid
    );
    if (
      cardCandidatesScanned >= MAX_SCANNED_MATCHES_PER_PATTERN
      || (
        result.counts.validated_credit_card >= MAX_MATCHES_PER_TYPE
        && result.counts.invalid_credit_card_candidate >= MAX_MATCHES_PER_TYPE
      )
    ) {
      break;
    }
  }

  var patterns = [
    // PII
    ['ssn', /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, 'medium', true],
    ['email', /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, 'weak', true],
    ['phone', /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, 'weak', true],
    ['drivers_license_candidate', /\b[A-Z]\d{7,12}\b/g, 'weak', null],

    // Financial and cryptocurrency
    ['bitcoin_wallet', /\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g, 'medium', null],
    ['ethereum_wallet', /\b0x[a-fA-F0-9]{40}\b/g, 'medium', true],
    ['monero_wallet', /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/g, 'medium', null],

    // Network and infrastructure
    ['ipv4', /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, 'weak', true],
    ['ipv6_full', /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, 'weak', true],
    ['onion_url', /\b[a-z2-7]{16,56}\.onion\b/gi, 'weak', true],
    ['domain', /\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|xyz|ru|cc|to)\b/gi, 'weak', true],

    // Vulnerability and malware indicators
    ['cve', /\bCVE-\d{4}-\d{4,}\b/gi, 'medium', true],
    ['md5_hash', /\b[a-fA-F0-9]{32}\b/g, 'medium', true],
    ['sha1_hash', /\b[a-fA-F0-9]{40}\b/g, 'medium', true],
    ['sha256_hash', /\b[a-fA-F0-9]{64}\b/g, 'medium', true],

    // Credentials and secrets
    ['private_key_marker', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, 'strong', true],
    ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, 'strong', true],
    ['aws_secret_access_key', /\b(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, 'strong', true],
    ['password_assignment', /\b(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{4,512}['"]?/gi, 'strong', null],
    ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, 'medium', null],
    ['aws_access_key_id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'medium', true],
    ['token_assignment', /\b(?:api[_\-]?key|apikey|access[_\-]?token|auth[_\-]?token|token)\s*[=:]\s*['"]?[A-Za-z0-9_./+=\-]{16,}['"]?/gi, 'medium', null]
  ];

  patterns.sort(function(left, right) {
    return strengthRank(right[2]) - strengthRank(left[2]);
  });

  for (var patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    scan(
      patterns[patternIndex][0],
      patterns[patternIndex][1],
      patterns[patternIndex][2],
      patterns[patternIndex][3]
    );
  }

  var summaryLines = [];
  var countTypes = Object.keys(result.counts).sort();
  for (var countIndex = 0; countIndex < countTypes.length; countIndex += 1) {
    var countType = countTypes[countIndex];
    summaryLines.push(countType + '_count=' + result.counts[countType]);
  }
  result.summary_text = summaryLines.join('\n');

  var strongScore = Math.min(60, result.strong_count * 20);
  var mediumScore = Math.min(30, result.medium_count * 10);
  var weakScore = Math.min(10, result.weak_count);
  result.evidence_score = Math.min(100, strongScore + mediumScore + weakScore);

  return result;
$$;

-- Safe smoke test: values below are synthetic test fixtures.
-- SELECT NOCTURNE.RAW.DETECT_INDICATORS(
--   'Card 4532015112830366, email analyst@example.com, CVE-2026-12345'
-- );
