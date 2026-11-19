//! Minimal JSON parser and number/byte helpers for flat and nested signing
//! requests.
//!
//! The parser accepts the subset the wallet needs: objects, arrays, strings
//! without escapes, integers and `true`/`false`/`null` are rejected because no
//! request uses them. Everything is borrowed from the input, so parsing does
//! not copy request bytes; the ABI wipes the uploaded buffer after the call.

/// A parsed JSON value borrowing strings from the request text.
pub enum Value<'a> {
    Str(&'a str),
    Num(&'a str),
    Array(Vec<Value<'a>>),
    Object(Vec<(&'a str, Value<'a>)>),
}

/// Parse one JSON value; trailing characters are rejected.
pub fn parse(text: &str) -> Result<Value<'_>, String> {
    let mut parser = Parser {
        text,
        bytes: text.as_bytes(),
        at: 0,
    };
    parser.skip_whitespace();
    let value = parser.value()?;
    parser.skip_whitespace();
    if parser.at != parser.bytes.len() {
        return Err("trailing characters after the JSON value".to_owned());
    }
    Ok(value)
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn skip_whitespace(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.at += 1;
        }
    }

    fn value(&mut self) -> Result<Value<'a>, String> {
        match self.bytes.get(self.at) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => {
                let (text, next) = self.string()?;
                self.at = next;
                Ok(Value::Str(text))
            }
            Some(byte) if byte.is_ascii_digit() || *byte == b'-' => self.number(),
            Some(_) => Err(
                "unsupported JSON value (only objects, arrays, strings and integers)".to_owned(),
            ),
            None => Err("unexpected end of JSON input".to_owned()),
        }
    }

    fn object(&mut self) -> Result<Value<'a>, String> {
        self.at += 1; // '{'
        self.skip_whitespace();
        let mut pairs = Vec::new();
        if self.bytes.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Value::Object(pairs));
        }
        loop {
            self.skip_whitespace();
            if self.bytes.get(self.at) != Some(&b'"') {
                return Err("expected a quoted JSON object key".to_owned());
            }
            let (key, next) = self.string()?;
            self.at = next;
            self.skip_whitespace();
            if self.bytes.get(self.at) != Some(&b':') {
                return Err(format!("expected ':' after \"{key}\""));
            }
            self.at += 1;
            self.skip_whitespace();
            let value = self.value()?;
            pairs.push((key, value));
            self.skip_whitespace();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Value::Object(pairs));
                }
                _ => return Err("expected ',' or '}' in a JSON object".to_owned()),
            }
        }
    }

    fn array(&mut self) -> Result<Value<'a>, String> {
        self.at += 1; // '['
        self.skip_whitespace();
        let mut items = Vec::new();
        if self.bytes.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value()?);
            self.skip_whitespace();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err("expected ',' or ']' in a JSON array".to_owned()),
            }
        }
    }

    fn string(&self) -> Result<(&'a str, usize), String> {
        let mut at = self.at + 1;
        while at < self.bytes.len() {
            match self.bytes[at] {
                b'"' => {
                    let value = &self.text[self.at + 1..at];
                    if !value.is_ascii() {
                        return Err("request strings must be ASCII".to_owned());
                    }
                    return Ok((value, at + 1));
                }
                b'\\' => {
                    return Err(
                        "escaped characters are not supported in request strings".to_owned()
                    );
                }
                byte if byte < 0x20 => {
                    return Err("control characters are not allowed in request strings".to_owned());
                }
                _ => at += 1,
            }
        }
        Err("unterminated string in request".to_owned())
    }

    fn number(&mut self) -> Result<Value<'a>, String> {
        let start = self.at;
        if self.bytes.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        let digits = self.at;
        while matches!(self.bytes.get(self.at), Some(byte) if byte.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at == digits {
            return Err("invalid JSON number".to_owned());
        }
        if matches!(self.bytes.get(self.at), Some(b'.' | b'e' | b'E')) {
            return Err("JSON numbers must be integers in a signing request".to_owned());
        }
        Ok(Value::Num(&self.text[start..self.at]))
    }
}

/// Strip one optional `0x`/`0X` prefix.
pub fn strip_0x(text: &str) -> Option<&str> {
    text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
}

/// Parse a decimal or `0x`-prefixed hexadecimal unsigned integer.
pub fn parse_u128(text: &str, field: &str) -> Result<u128, String> {
    let Some(hex) = strip_0x(text) else {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!(
                "{field} must be a decimal or 0x-prefixed hexadecimal number"
            ));
        }
        return text
            .parse::<u128>()
            .map_err(|_| format!("{field} does not fit in 128 bits"));
    };
    if hex.is_empty() {
        return Ok(0);
    }
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} is not hexadecimal"));
    }
    u128::from_str_radix(hex, 16).map_err(|_| format!("{field} does not fit in 128 bits"))
}

/// Parse a decimal or `0x`-prefixed hexadecimal unsigned 64-bit integer.
pub fn parse_u64(text: &str, field: &str) -> Result<u64, String> {
    let value = parse_u128(text, field)?;
    u64::try_from(value).map_err(|_| format!("{field} does not fit in 64 bits"))
}

/// Parse an even-length hexadecimal byte string with an optional `0x` prefix.
pub fn parse_bytes(text: &str, field: &str) -> Result<Vec<u8>, String> {
    let hex = strip_0x(text).unwrap_or(text);
    if !hex.len().is_multiple_of(2) {
        return Err(format!("{field} must have an even number of hex digits"));
    }
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} is not hexadecimal"));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        out.push(
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| format!("{field} is not hexadecimal"))?,
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_objects_and_arrays() {
        let Value::Object(pairs) =
            parse(r#"{"network":"testnet","inputs":[{"txid":"11","vout":0}],"outputs":[]}"#)
                .unwrap()
        else {
            panic!("object expected");
        };
        assert_eq!(pairs.len(), 3);
        assert!(matches!(pairs[0].1, Value::Str("testnet")));
        let Value::Array(inputs) = &pairs[1].1 else {
            panic!("array expected");
        };
        let Value::Object(fields) = &inputs[0] else {
            panic!("object expected");
        };
        assert_eq!(fields[0].0, "txid");
        assert!(matches!(fields[1].1, Value::Num("0")));
    }

    #[test]
    fn rejects_escapes_trailing_data_and_fractions() {
        assert!(parse(r#"{"a":"x\"y"}"#).is_err());
        assert!(parse("{}x").is_err());
        assert!(parse(r#"{"a":1.5}"#).is_err());
        assert!(parse(r#"{"a":true}"#).is_err());
        assert!(parse(r#"{"a":}"#).is_err());
        assert!(parse(r#"{"a":1,}"#).is_err());
        assert!(parse("").is_err());
    }
}
