//! Bitcoin puzzle targets #1..#160 used by the public puzzle browser.
//!
//! Source: `privatekeyfinder.io/bitcoin-puzzle/<n>/random`, the public
//! `window.PUZZLE_CONFIG.targetAddress` value on each page, crawled 2026-11-19
//! for every number from 1 to 160. The donor also marks solved puzzles; the
//! flag is copied as-is and matches the on-chain balances we spot-checked
//! (for example #75 and #80 are spent, #71 still holds the prize).
//!
//! Puzzle `n` covers the inclusive private-key range `2^(n-1) .. 2^n - 1`.
//! The #71 entry was verified against the donor page target
//! `1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`; see the tests at the bottom.

use num_bigint::BigUint;

/// Number of puzzles in the public dataset.
pub const PUZZLE_COUNT: u32 = 160;

/// `(target address, solved)` for puzzles 1..160, in order.
const PUZZLE_TARGETS: [(&str, bool); 160] = [
    ("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", true),
    ("1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb", true),
    ("19ZewH8Kk1PDbSNdJ97FP4EiCjTRaZMZQA", true),
    ("1EhqbyUMvvs7BfL8goY6qcPbD6YKfPqb7e", true),
    ("1E6NuFjCi27W5zoXg8TRdcSRq84zJeBW3k", true),
    ("1PitScNLyp2HCygzadCh7FveTnfmpPbfp8", true),
    ("1McVt1vMtCC7yn5b9wgX1833yCcLXzueeC", true),
    ("1M92tSqNmQLYw33fuBvjmeadirh1ysMBxK", true),
    ("1CQFwcjw1dwhtkVWBttNLDtqL7ivBonGPV", true),
    ("1LeBZP5QCwwgXRtmVUvTVrraqPUokyLHqe", true),
    ("1PgQVLmst3Z314JrQn5TNiys8Hc38TcXJu", true),
    ("1DBaumZxUkM4qMQRt2LVWyFJq5kDtSZQot", true),
    ("1Pie8JkxBT6MGPz9Nvi3fsPkr2D8q3GBc1", true),
    ("1ErZWg5cFCe4Vw5BzgfzB74VNLaXEiEkhk", true),
    ("1QCbW9HWnwQWiQqVo5exhAnmfqKRrCRsvW", true),
    ("1BDyrQ6WoF8VN3g9SAS1iKZcPzFfnDVieY", true),
    ("1HduPEXZRdG26SUT5Yk83mLkPyjnZuJ7Bm", true),
    ("1GnNTmTVLZiqQfLbAdp9DVdicEnB5GoERE", true),
    ("1NWmZRpHH4XSPwsW6dsS3nrNWfL1yrJj4w", true),
    ("1HsMJxNiV7TLxmoF6uJNkydxPFDog4NQum", true),
    ("14oFNXucftsHiUMY8uctg6N487riuyXs4h", true),
    ("1CfZWK1QTQE3eS9qn61dQjV89KDjZzfNcv", true),
    ("1L2GM8eE7mJWLdo3HZS6su1832NX2txaac", true),
    ("1rSnXMr63jdCuegJFuidJqWxUPV7AtUf7", true),
    ("15JhYXn6Mx3oF4Y7PcTAv2wVVAuCFFQNiP", true),
    ("1JVnST957hGztonaWK6FougdtjxzHzRMMg", true),
    ("128z5d7nN7PkCuX5qoA4Ys6pmxUYnEy86k", true),
    ("12jbtzBb54r97TCwW3G1gCFoumpckRAPdY", true),
    ("19EEC52krRUK1RkUAEZmQdjTyHT7Gp1TYT", true),
    ("1LHtnpd8nU5VHEMkG2TMYYNUjjLc992bps", true),
    ("1LhE6sCTuGae42Axu1L1ZB7L96yi9irEBE", true),
    ("1FRoHA9xewq7DjrZ1psWJVeTer8gHRqEvR", true),
    ("187swFMjz1G54ycVU56B7jZFHFTNVQFDiu", true),
    ("1PWABE7oUahG2AFFQhhvViQovnCr4rEv7Q", true),
    ("1PWCx5fovoEaoBowAvF5k91m2Xat9bMgwb", true),
    ("1Be2UF9NLfyLFbtm3TCbmuocc9N1Kduci1", true),
    ("14iXhn8bGajVWegZHJ18vJLHhntcpL4dex", true),
    ("1HBtApAFA9B2YZw3G2YKSMCtb3dVnjuNe2", true),
    ("122AJhKLEfkFBaGAd84pLp1kfE7xK3GdT8", true),
    ("1EeAxcprB2PpCnr34VfZdFrkUWuxyiNEFv", true),
    ("1L5sU9qvJeuwQUdt4y1eiLmquFxKjtHr3E", true),
    ("1E32GPWgDyeyQac4aJxm9HVoLrrEYPnM4N", true),
    ("1PiFuqGpG8yGM5v6rNHWS3TjsG6awgEGA1", true),
    ("1CkR2uS7LmFwc3T2jV8C1BhWb5mQaoxedF", true),
    ("1NtiLNGegHWE3Mp9g2JPkgx6wUg4TW7bbk", true),
    ("1F3JRMWudBaj48EhwcHDdpeuy2jwACNxjP", true),
    ("1Pd8VvT49sHKsmqrQiP61RsVwmXCZ6ay7Z", true),
    ("1DFYhaB2J9q1LLZJWKTnscPWos9VBqDHzv", true),
    ("12CiUhYVTTH33w3SPUBqcpMoqnApAV4WCF", true),
    ("1MEzite4ReNuWaL5Ds17ePKt2dCxWEofwk", true),
    ("1NpnQyZ7x24ud82b7WiRNvPm6N8bqGQnaS", true),
    ("15z9c9sVpu6fwNiK7dMAFgMYSK4GqsGZim", true),
    ("15K1YKJMiJ4fpesTVUcByoz334rHmknxmT", true),
    ("1KYUv7nSvXx4642TKeuC2SNdTk326uUpFy", true),
    ("1LzhS3k3e9Ub8i2W1V8xQFdB8n2MYCHPCa", true),
    ("17aPYR1m6pVAacXg1PTDDU7XafvK1dxvhi", true),
    ("15c9mPGLku1HuW9LRtBf4jcHVpBUt8txKz", true),
    ("1Dn8NF8qDyyfHMktmuoQLGyjWmZXgvosXf", true),
    ("1HAX2n9Uruu9YDt4cqRgYcvtGvZj1rbUyt", true),
    ("1Kn5h2qpgw9mWE5jKpk8PP4qvvJ1QVy8su", true),
    ("1AVJKwzs9AskraJLGHAZPiaZcrpDr1U6AB", true),
    ("1Me6EfpwZK5kQziBwBfvLiHjaPGxCKLoJi", true),
    ("1NpYjtLira16LfGbGwZJ5JbDPh3ai9bjf4", true),
    ("16jY7qLJnxb7CHZyqBP8qca9d51gAjyXQN", true),
    ("18ZMbwUFLMHoZBbfpCjUJQTCMCbktshgpe", true),
    ("13zb1hQbWVsc2S7ZTZnP2G4undNNpdh5so", true),
    ("1BY8GQbnueYofwSuFAT3USAhGjPrkxDdW9", true),
    ("1MVDYgVaSN6iKKEsbzRUAYFrYJadLYZvvZ", true),
    ("19vkiEajfhuZ8bs8Zu2jgmC6oqZbWqhxhG", true),
    ("19YZECXj3SxEZMoUeJ1yiPsw8xANe7M7QR", true),
    ("1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU", false),
    ("1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR", false),
    ("12VVRNPi4SJqUTsp6FmqDqY5sGosDtysn4", false),
    ("1FWGcVDK3JGzCC3WtkYetULPszMaK2Jksv", false),
    ("1J36UjUByGroXcCvmj13U6uwaVv9caEeAt", true),
    ("1DJh2eHFYQfACPmrvpyWc8MSTYKh7w9eRF", false),
    ("1Bxk4CQdqL9p22JEtDfdXMsng1XacifUtE", false),
    ("15qF6X51huDjqTmF9BJgxXdt1xcj46Jmhb", false),
    ("1ARk8HWJMn8js8tQmGUJeQHjSE7KRkn2t8", false),
    ("1BCf6rHUW6m3iH2ptsvnjgLruAiPQQepLe", true),
    ("15qsCm78whspNQFydGJQk5rexzxTQopnHZ", false),
    ("13zYrYhhJxp6Ui1VV7pqa5WDhNWM45ARAC", false),
    ("14MdEb4eFcT3MVG5sPFG4jGLuHJSnt1Dk2", false),
    ("1CMq3SvFcVEcpLMuuH8PUcNiqsK1oicG2D", false),
    ("1Kh22PvXERd2xpTQk3ur6pPEqFeckCJfAr", true),
    ("1K3x5L6G57Y494fDqBfrojD28UJv4s5JcK", false),
    ("1PxH3K1Shdjb7gSEoTX7UPDZ6SH4qGPrvq", false),
    ("16AbnZjZZipwHMkYKBSfswGWKDmXHjEpSf", false),
    ("19QciEHbGVNY4hrhfKXmcBBCrJSBZ6TaVt", false),
    ("1L12FHH2FHjvTviyanuiFVfmzCy46RRATU", true),
    ("1EzVHtmbN4fs4MiNk3ppEnKKhsmXYJ4s74", false),
    ("1AE8NzzgKE7Yhz7BWtAcAAxiFMbPo82NB5", false),
    ("17Q7tuG2JwFFU9rXVj3uZqRtioH3mx2Jad", false),
    ("1K6xGMUbs6ZTXBnhw1pippqwK6wjBWtNpL", false),
    ("19eVSDuizydXxhohGh8Ki9WY9KsHdSwoQC", true),
    ("15ANYzzCp5BFHcCnVFzXqyibpzgPLWaD8b", false),
    ("18ywPwj39nGjqBrQJSzZVq2izR12MDpDr8", false),
    ("1CaBVPrwUxbQYYswu32w7Mj4HR4maNoJSX", false),
    ("1JWnE6p6UN7ZJBN7TtcbNDoRcjFtuDWoNL", false),
    ("1KCgMv8fo2TPBpddVi9jqmMmcne9uSNJ5F", true),
    ("1CKCVdbDJasYmhswB6HKZHEAnNaDpK7W4n", false),
    ("1PXv28YxmYMaB8zxrKeZBW8dt2HK7RkRPX", false),
    ("1AcAmB6jmtU6AiEcXkmiNE9TNVPsj9DULf", false),
    ("1EQJvpsmhazYCcKX5Au6AZmZKRnzarMVZu", false),
    ("1CMjscKB3QW7SDyQ4c3C3DEUHiHRhiZVib", true),
    ("18KsfuHuzQaBTNLASyj15hy4LuqPUo1FNB", false),
    ("15EJFC5ZTs9nhsdvSUeBXjLAuYq3SWaxTc", false),
    ("1HB1iKUqeffnVsvQsbpC6dNi1XKbyNuqao", false),
    ("1GvgAXVCbA8FBjXfWiAms4ytFeJcKsoyhL", false),
    ("12JzYkkN76xkwvcPT6AWKZtGX6w2LAgsJg", true),
    ("1824ZJQ7nKJ9QFTRBqn7z7dHV5EGpzUpH3", false),
    ("18A7NA9FTsnJxWgkoFfPAFbQzuQxpRtCos", false),
    ("1NeGn21dUDDeqFQ63xb2SpgUuXuBLA4WT4", false),
    ("174SNxfqpdMGYy5YQcfLbSTK3MRNZEePoy", false),
    ("1NLbHuJebVwUZ1XqDjsAyfTRUPwDQbemfv", true),
    ("1MnJ6hdhvK37VLmqcdEwqC3iFxyWH2PHUV", false),
    ("1KNRfGWw7Q9Rmwsc6NT5zsdvEb9M2Wkj5Z", false),
    ("1PJZPzvGX19a7twf5HyD2VvNiPdHLzm9F6", false),
    ("1GuBBhf61rnvRe4K8zu8vdQB3kHzwFqSy7", false),
    ("17s2b9ksz5y7abUm92cHwG8jEPCzK3dLnT", true),
    ("1GDSuiThEV64c166LUFC9uDcVdGjqkxKyh", false),
    ("1Me3ASYt5JCTAK2XaC32RMeH34PdprrfDx", false),
    ("1CdufMQL892A69KXgv6UNBD17ywWqYpKut", false),
    ("1BkkGsX9ZM6iwL3zbqs7HWBV7SvosR6m8N", false),
    ("1PXAyUB8ZoH3WD8n5zoAthYjN15yN5CVq5", true),
    ("1AWCLZAjKbV1P7AHvaPNCKiB7ZWVDMxFiz", false),
    ("1G6EFyBRU86sThN3SSt3GrHu1sA7w7nzi4", false),
    ("1MZ2L1gFrCtkkn6DnTT2e4PFUTHw9gNwaj", false),
    ("1Hz3uv3nNZzBVMXLGadCucgjiCs5W9vaGz", false),
    ("1Fo65aKq8s8iquMt6weF1rku1moWVEd5Ua", true),
    ("16zRPnT8znwq42q7XeMkZUhb1bKqgRogyy", false),
    ("1KrU4dHE5WrW8rhWDsTRjR21r8t3dsrS3R", false),
    ("17uDfp5r4n441xkgLFmhNoSW1KWp6xVLD", false),
    ("13A3JrvXmvg5w9XGvyyR4JEJqiLz8ZySY3", false),
    ("16RGFo6hjq9ym6Pj7N5H7L1NR1rVPJyw2v", true),
    ("1UDHPdovvR985NrWSkdWQDEQ1xuRiTALq", false),
    ("15nf31J46iLuK1ZkTnqHo7WgN5cARFK3RA", false),
    ("1Ab4vzG6wEQBDNQM1B2bvUz4fqXXdFk2WT", false),
    ("1Fz63c775VV9fNyj25d9Xfw3YHE6sKCxbt", false),
    ("1QKBaU6WAeycb3DbKbLBkX7vJiaS8r42Xo", false),
    ("1CD91Vm97mLQvXhrnoMChhJx4TP9MaQkJo", false),
    ("15MnK2jXPqTMURX4xC3h4mAZxyCcaWWEDD", false),
    ("13N66gCzWWHEZBxhVxG18P8wyjEWF9Yoi1", false),
    ("1NevxKDYuDcCh1ZMMi6ftmWwGrZKC6j7Ux", false),
    ("19GpszRNUej5yYqxXoLnbZWKew3KdVLkXg", false),
    ("1M7ipcdYHey2Y5RZM34MBbpugghmjaV89P", false),
    ("18aNhurEAJsw6BAgtANpexk5ob1aGTwSeL", false),
    ("1FwZXt6EpRT7Fkndzv6K4b4DFoT4trbMrV", false),
    ("1CXvTzR6qv8wJ7eprzUKeWxyGcHwDYP1i2", false),
    ("1MUJSJYtGPVGkBCTqGspnxyHahpt5Te8jy", false),
    ("13Q84TNNvgcL3HJiqQPvyBb9m4hxjS3jkV", false),
    ("1LuUHyrQr8PKSvbcY1v1PiuGuqFjWpDumN", false),
    ("18192XpzzdDi2K11QVHR7td2HcPS6Qs5vg", false),
    ("1NgVmsCCJaKLzGyKLFJfVequnFW9ZvnMLN", false),
    ("1AoeP37TmHdFh8uN72fu9AqgtLrUwcv2wJ", false),
    ("1FTpAbQa4h8trvhQXjXnmNhqdiGBd1oraE", false),
    ("14JHoRAdmJg3XR4RjMDh6Wed6ft6hzbQe9", false),
    ("19z6waranEf8CcP8FqNgdwUe1QRxvUNKBG", false),
    ("14u4nA5sugaswb6SZgn5av2vuChdMnD9E5", false),
    ("1NBC8uXJy1GiJ6drkiZa1WuKn51ps7EPTv", false),
];

/// One puzzle entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Puzzle {
    pub number: u32,
    pub target: &'static str,
    pub solved: bool,
}

/// Look up a puzzle by its number; `None` outside 1..=160.
pub fn puzzle(number: u32) -> Option<Puzzle> {
    if !(1..=PUZZLE_COUNT).contains(&number) {
        return None;
    }
    PUZZLE_TARGETS
        .get(number as usize - 1)
        .map(|(target, solved)| Puzzle {
            number,
            target,
            solved: *solved,
        })
}

/// Iterate puzzles in ascending order.
pub fn all() -> impl Iterator<Item = Puzzle> {
    (1..=PUZZLE_COUNT).filter_map(puzzle)
}

/// Inclusive private-key range of puzzle `n` as padded 64-character hex.
pub fn range_hex(number: u32) -> Option<(String, String)> {
    puzzle(number)?;
    let start = BigUint::from(1u8) << (number - 1);
    let end = (BigUint::from(1u8) << number) - BigUint::from(1u8);
    Some((
        format!("{:0>64}", start.to_str_radix(16)),
        format!("{:0>64}", end.to_str_radix(16)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puzzle_seventy_one_matches_the_public_dataset() {
        let item = puzzle(71).expect("#71");
        assert_eq!(item.target, "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU");
        assert!(!item.solved);
        let (start, end) = range_hex(71).expect("#71 range");
        assert_eq!(
            start,
            "0000000000000000000000000000000000000000000000400000000000000000"
        );
        assert_eq!(
            end,
            "00000000000000000000000000000000000000000000007fffffffffffffffff"
        );
    }

    #[test]
    fn every_range_is_the_bit_tower_slice() {
        for item in all() {
            let (start, end) = range_hex(item.number).expect("range");
            let start_value = BigUint::parse_bytes(start.as_bytes(), 16).expect("start hex");
            let end_value = BigUint::parse_bytes(end.as_bytes(), 16).expect("end hex");
            assert_eq!(start_value, BigUint::from(1u8) << (item.number - 1));
            assert_eq!(
                end_value,
                (BigUint::from(1u8) << item.number) - BigUint::from(1u8)
            );
            assert_eq!(start.len(), 64);
            assert_eq!(end.len(), 64);
        }
    }

    #[test]
    fn lookups_are_bounded_and_distinct() {
        assert!(puzzle(0).is_none());
        assert!(puzzle(PUZZLE_COUNT + 1).is_none());
        assert_eq!(all().count(), PUZZLE_COUNT as usize);
        let targets: std::collections::HashSet<_> = all().map(|item| item.target).collect();
        assert_eq!(targets.len(), PUZZLE_COUNT as usize);
        assert_eq!(all().filter(|item| item.solved).count(), 83);
        assert!(all().any(|item| item.number == 160 && !item.solved));
    }
}
