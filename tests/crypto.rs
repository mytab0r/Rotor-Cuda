//! secp256k1 vectors and arithmetic properties for the M1 crypto core.

use rotor::base58::{self, address_from_hash160, decode_wif, wif_encode};
use rotor::field::Fe;
use rotor::hashes;
use rotor::point::{Affine, Jacobian, batch_to_affine};
use rotor::scalar::Scalar;
use rotor::secp;

const G_X: &str = "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";
const G_Y: &str = "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8";

fn fe(text: &str) -> Fe {
    Fe::from_hex(text).expect("valid field element")
}

fn point(x: &str, y: &str) -> Affine {
    Affine { x: fe(x), y: fe(y) }
}

fn scalar(value: u64) -> Scalar {
    Scalar::from_u64(value)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn bytes32(text: &str) -> [u8; 32] {
    let padded = format!("{text:0>64}");
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&padded[index * 2..index * 2 + 2], 16).expect("hex byte");
    }
    out
}

#[test]
fn generator_and_small_multiples() {
    assert_eq!(secp::g(), point(G_X, G_Y));
    assert_eq!(
        secp::mul_g(&scalar(2)),
        point(
            "C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5",
            "1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A",
        )
    );
    assert_eq!(
        secp::mul_g(&scalar(3)),
        point(
            "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
            "388F7B0F632DE8140FE337E62A37F3566500A99934C2231B6CB9FD7584B8E672",
        )
    );
    assert_eq!(
        secp::mul_g(&scalar(4)),
        point(
            "E493DBF1C10D80F3581E4904930B1404CC6C13900EE0758474FA94ABE8C4CD13",
            "51ED993EA0D455B75642E2098EA51448D967AE33BFBDFE40CFE97BDC47739922",
        )
    );
    assert_eq!(
        secp::mul_g(&scalar(5)),
        point(
            "2F8BDE4D1A07209355B4A7250A5C5128E88B84BDDC619AB7CBA8D569B240EFE4",
            "D8AC222636E5E3D6D4DBA9DDA6C9C426F788271BAB0D6840DCA87D3AA6AC62D6",
        )
    );
}

#[test]
fn repeated_addition_matches_multiplication() {
    let mut current = secp::g();
    for k in 1..=64u64 {
        let sum = secp::add(&current, &secp::g()).expect("finite sum");
        assert_eq!(sum, secp::mul_g(&scalar(k + 1)), "k = {k}");
        current = sum;
    }
}

#[test]
fn batch_inversion_matches_individual_inversion() {
    let mut jacobian = Jacobian::from_affine(&secp::g());
    let mut points = Vec::with_capacity(257);
    for _ in 0..257 {
        points.push(jacobian);
        jacobian = jacobian.add_affine(&secp::g());
    }

    let batch = batch_to_affine(&points);
    assert_eq!(batch.len(), points.len());
    for (point, batched) in points.iter().zip(&batch) {
        assert_eq!(point.to_affine(), *batched);
    }

    // Infinity entries must not poison the batch.
    let mut with_infinity = points;
    with_infinity.insert(128, Jacobian::infinity());
    let batch = batch_to_affine(&with_infinity);
    assert!(batch[127].is_some());
    assert!(batch[128].is_none());
    assert!(batch[129].is_some());
    assert_eq!(
        batch[129],
        with_infinity[129].to_affine(),
        "entry after the infinity must still be normalized"
    );
}

#[test]
fn genkey_vector() {
    let key = Scalar::from_hex("46b9e861b63d3509c88b7817275a30d22d62c8cd8fa6486ddee35ef0d8e0495f")
        .expect("valid scalar");
    assert_eq!(
        secp::mul_g(&key),
        point(
            "2500e7f3fbddf2842903f544ddc87494ce95029ace4e257d54ba77f2bc1f3a88",
            "37a9461c4f1c57fecc499753381e772a128a5820a924a2fa05162eb662987a9f",
        )
    );
}

#[test]
fn hash160_and_p2pkh_address() {
    let generator = secp::g();
    assert_eq!(
        hex(&secp::hash160(&generator, true)),
        "751e76e8199196d454941c45d1b3a323f1433bd6"
    );

    let hash = secp::hash160(&generator, true);
    assert_eq!(
        address_from_hash160(&hash, true),
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    );
}

#[test]
fn ethereum_address_for_private_key_one() {
    assert_eq!(
        hex(&secp::eth_address(&secp::g())),
        "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
}

#[test]
fn wif_for_private_key_one() {
    // Independently verified Base58Check encoding of
    // 80 || 00..01 || 01.
    let canonical = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
    assert_eq!(wif_encode(&scalar(1), true), canonical);
    let (key, compressed) = decode_wif(canonical).expect("canonical WIF decodes");
    assert_eq!(key, scalar(1));
    assert!(compressed);

    // The M1 brief's string `...9NRuiZFAX5a6P5M` is not valid Base58Check
    // (checksum mismatch), so it must be rejected rather than accepted.
    assert!(
        decode_wif("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX5a6P5M").is_err(),
        "the brief's WIF string is not a valid Base58Check value"
    );
}

#[test]
fn address_wif_pairs_from_cpp_selfcheck() {
    // SECP256k1.cpp:134-140. The two `3...` entries are P2SH-P2WPKH
    // addresses, not P2PKH; they are validated with that encoding.
    const PAIRS: &[(&str, &str)] = &[
        (
            "15t3Nt1zyMETkHbjJTTshxLnqPzQvAtdCe",
            "5HqoeNmaz17FwZRqn7kCBP1FyJKSe4tt42XZB7426EJ2MVWDeqk",
        ),
        (
            "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            "5J4XJRyLVgzbXEgh8VNi4qovLzxRftzMd8a18KkdXv4EqAwX3tS",
        ),
        (
            "1Test6BNjSJC5qwYXsjwKVLvz7DpfLehy",
            "5HytzR8p5hp8Cfd8jsVFnwMNXMsEW1sssFxMQYqEUjGZN72iLJ2",
        ),
        (
            "16S5PAsGZ8VFM1CRGGLqm37XHrp46f6CTn",
            "KxMUSkFhEzt2eJHscv2vNSTnnV2cgAXgL4WDQBTx7Ubd9TZmACAz",
        ),
        (
            "1Tst2RwMxZn9cYY5mQhCdJic3JJrK7Fq7",
            "L1vamTpSeK9CgynRpSJZeqvUXf6dJa25sfjb2uvtnhj65R5TymgF",
        ),
        (
            "3CyQYcByvcWK8BkYJabBS82yDLNWt6rWSx",
            "KxMUSkFhEzt2eJHscv2vNSTnnV2cgAXgL4WDQBTx7Ubd9TZmACAz",
        ),
        (
            "31to1KQe67YjoDfYnwFJThsGeQcFhVDM5Q",
            "KxV2Tx5jeeqLHZ1V9ufNv1doTZBZuAc5eY24e6b27GTkDhYwVad7",
        ),
    ];

    for (address, wif) in PAIRS {
        let (key, compressed) = decode_wif(wif).expect("valid WIF");
        let hash = secp::hash160(&secp::mul_g(&key), compressed);
        if address.starts_with('1') {
            assert_eq!(address_from_hash160(&hash, compressed), *address, "{wif}");
        } else {
            // P2SH-P2WPKH: OP_0 <20-byte pubkey hash>, then version 5.
            let mut redeem = [0u8; 22];
            redeem[0] = 0x00;
            redeem[1] = 0x14;
            redeem[2..].copy_from_slice(&hash);
            let nested = hashes::hash160(&redeem);
            let mut payload = [0u8; 21];
            payload[0] = 0x05;
            payload[1..].copy_from_slice(&nested);
            assert_eq!(base58::encode_check(&payload), *address, "{wif}");
        }
    }
}

#[test]
fn pubkey_parse_roundtrip() {
    let generator = secp::g();
    let mut want_compressed = false;
    let parsed = secp::parse_pubkey_hex(&hex(&secp::compress(&generator)), &mut want_compressed)
        .expect("compressed key parses");
    assert!(want_compressed);
    assert_eq!(parsed, generator);

    let parsed = secp::parse_pubkey_hex(&hex(&secp::uncompress(&generator)), &mut want_compressed)
        .expect("uncompressed key parses");
    assert!(!want_compressed);
    assert_eq!(parsed, generator);
}

#[test]
fn field_properties() {
    let p_minus_one = fe("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2E");
    assert!(p_minus_one.add(&Fe::ONE).is_zero());
    assert_eq!(Fe::ONE.neg(), p_minus_one);

    let four = Fe::from_u64(4);
    let root = four.sqrt().expect("4 is a square");
    assert_eq!(root.square(), four);

    let value = fe("1234567890ABCDEFFEDCBA0987654321");
    assert_eq!(
        value.mul(&value.invert().expect("nonzero elements invert")),
        Fe::ONE
    );
    assert_eq!(p_minus_one.invert(), Some(p_minus_one));

    assert_eq!(Fe::ZERO.invert(), None);
    assert!(
        Fe::from_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F").is_none()
    );
    assert!(
        Fe::from_bytes_be(&bytes32(
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"
        ))
        .is_none()
    );
}

#[test]
fn scalar_properties() {
    let n_minus_one =
        Scalar::from_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140")
            .expect("n-1 is valid");
    assert!(n_minus_one.add(&Scalar::ONE).is_zero());
    assert!(n_minus_one.add_u64(1).is_zero());
    assert!(n_minus_one.bit(255));

    let value = Scalar::from_hex("1234567890abcdef").expect("valid scalar");
    assert_eq!(value.mul(&scalar(2)), value.add(&value));
    assert_eq!(value.add_u64(5), value.add(&Scalar::from_u64(5)));

    // Carry across the lowest limb.
    let low_full = Scalar::from_hex("FFFFFFFFFFFFFFFF").expect("valid scalar");
    let two_to_64 = Scalar::from_hex("10000000000000000").expect("2^64 is valid");
    assert_eq!(low_full.add_u64(1), two_to_64);

    // (n-1)^2 = 1 mod n exercises the full 512-bit reduction path.
    assert_eq!(n_minus_one.mul(&n_minus_one), Scalar::ONE);

    assert!(
        Scalar::from_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141")
            .is_none()
    );
}
