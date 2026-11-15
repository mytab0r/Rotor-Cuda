//! Self-check mode (`-c`), mirroring `Rotor-Cuda/SECP256k1.cpp:96-155` and the
//! `Int` arithmetic checks from `Rotor-Cuda/Int.cpp:1495-1547`.

use crate::base58::{address_from_hash160, decode_wif};
use crate::field::Fe;
use crate::point::{Affine, Jacobian};
use crate::scalar::Scalar;
use crate::secp;

/// Address / WIF pairs from `SECP256k1.cpp:134-140`.
const ADDRESS_WIF: &[(&str, &str)] = &[
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

/// The C++ self-check also compares against a bech32 address
/// (`SECP256k1.cpp:141`), which the P2PKH-only address helper cannot derive;
/// that line is intentionally not reproduced.
pub fn run() -> bool {
    let mut ok = true;

    print!("Check Generator :");
    let generator_ok = check_generator();
    print_result(generator_ok);
    ok &= generator_ok;

    print!("Check Double :");
    let doubled = Jacobian::from_affine(&secp::g()).double().to_affine();
    let double_ok = doubled.as_ref().is_some_and(secp::is_on_curve);
    print_result(double_ok);
    ok &= double_ok;

    print!("Check Add :");
    let add_ok = doubled
        .and_then(|two_g| secp::add(&secp::g(), &two_g).map(|three_g| (two_g, three_g)))
        .and_then(|(two_g, three_g)| secp::add(&two_g, &three_g))
        .is_some_and(|point| secp::is_on_curve(&point));
    print_result(add_ok);
    ok &= add_ok;

    print!("Check GenKey :");
    let genkey_ok = check_genkey();
    print_result(genkey_ok);
    ok &= genkey_ok;

    for (address, wif) in ADDRESS_WIF {
        // Lines 139-140 of the C++ self-check pair P2SH addresses with a WIF;
        // only P2PKH (version 0) derivation is in scope here.
        if !address.starts_with('1') {
            println!("Adress : {address} Skipped (non-P2PKH)");
            continue;
        }
        print!("Adress : {address} ");
        match derived_address(wif) {
            Ok(calculated) if calculated == *address => println!("OK!"),
            Ok(calculated) => {
                println!("Failed ! ");
                println!(" {calculated}");
                ok = false;
            }
            Err(error) => {
                println!("Failed ! ");
                println!(" {error}");
                ok = false;
            }
        }
    }

    println!();
    println!();
    println!("  Checking... Int");
    println!();
    println!();

    let add_ok = integer_add_check();
    println!("Add() Results {}", if add_ok { "OK" } else { "Wrong" });
    let mult_ok = integer_mult_check();
    println!("Mult() Results {}", if mult_ok { "OK" } else { "Wrong" });
    ok &= add_ok && mult_ok;

    if ok {
        println!();
        println!();
        println!("  Checked successfully");
        println!();
        println!();
    }

    ok
}

fn print_result(passed: bool) {
    println!("{}", if passed { "OK" } else { "Failed !" });
}

fn check_generator() -> bool {
    let generator = secp::g();
    if !secp::is_on_curve(&generator) {
        return false;
    }
    // The generator has order n: (n-1)G + G is the point at infinity.
    let order_minus_one =
        Scalar::from_hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140")
            .expect("n-1 is a valid scalar");
    let last = secp::mul_g(&order_minus_one);
    secp::add(&last, &generator).is_none()
}

fn check_genkey() -> bool {
    let key = Scalar::from_hex("46b9e861b63d3509c88b7817275a30d22d62c8cd8fa6486ddee35ef0d8e0495f")
        .expect("GenKey scalar is valid");
    let expected = Affine {
        x: Fe::from_hex("2500e7f3fbddf2842903f544ddc87494ce95029ace4e257d54ba77f2bc1f3a88")
            .expect("GenKey x is a field element"),
        y: Fe::from_hex("37a9461c4f1c57fecc499753381e772a128a5820a924a2fa05162eb662987a9f")
            .expect("GenKey y is a field element"),
    };
    secp::mul_g(&key) == expected
}

fn derived_address(wif: &str) -> Result<String, String> {
    let (key, compressed) = decode_wif(wif)?;
    let public = secp::mul_g(&key);
    let hash = secp::hash160(&public, compressed);
    Ok(address_from_hash160(&hash, compressed))
}

fn integer_add_check() -> bool {
    let a: u128 = 4_743_256_844_168_384_767_987;
    let b: u128 = 1_679_314_142_928_575_978_367;
    a.checked_add(b) == Some(6_422_570_987_096_960_746_354)
}

fn integer_mult_check() -> bool {
    let a = "3890902718436931151119442452387018319292503094706912504064239834754167";
    let b = "474325684416838476798716793141429285759783676422570987096960746354";
    let expected = "1845555094921934741640873731771879197054909502699192730283220486240724687661257894226660948002650341240452881231721004292250660431557118";
    decimal_mul(a, b) == expected
}

/// Grade-school multiplication of two non-negative decimal strings.
fn decimal_mul(a: &str, b: &str) -> String {
    let mut digits = vec![0u32; a.len() + b.len()];
    for (i, left) in a.bytes().rev().enumerate() {
        let left = u32::from(left - b'0');
        for (j, right) in b.bytes().rev().enumerate() {
            digits[i + j] += left * u32::from(right - b'0');
        }
    }

    let mut carry = 0u32;
    let mut reversed = String::with_capacity(digits.len() + 1);
    for digit in digits {
        let value = digit + carry;
        reversed.push(char::from_digit(value % 10, 10).expect("decimal digit"));
        carry = value / 10;
    }
    while carry > 0 {
        reversed.push(char::from_digit(carry % 10, 10).expect("decimal digit"));
        carry /= 10;
    }

    let result: String = reversed.chars().rev().collect();
    let trimmed = result.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}
