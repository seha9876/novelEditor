//! プロジェクトツリーの整数順位を計算する純粋関数。

/// 隣り合うノード間と再採番で使う共通の順位間隔。
pub const ORDER_GAP: i128 = 1_i128 << 32;

/// 順位をそのまま割り当てられない理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionError {
    /// 前後ノードの順位が逆転している。
    InvalidOrder,
    /// 間隔に整数がないか、端で間隔を確保できず再採番が必要。
    NeedsReindex,
    /// 再採番後の値を SQLite の INTEGER に格納できない。
    OutOfRange,
}

/// 前後の順位から新しい順位を計算する。安全な隙間がなければ再採番を要求する。
pub fn order_between(previous: Option<i64>, next: Option<i64>) -> Result<i64, PositionError> {
    let min = i64::MIN as i128;
    let max = i64::MAX as i128;

    let candidate = match (previous, next) {
        (None, None) => 0,
        (None, Some(next)) => (next as i128) - ORDER_GAP,
        (Some(previous), None) => (previous as i128) + ORDER_GAP,
        (Some(previous), Some(next)) => {
            let previous = previous as i128;
            let next = next as i128;
            if previous > next {
                return Err(PositionError::InvalidOrder);
            }
            if previous == next {
                return Err(PositionError::NeedsReindex);
            }

            previous + (next - previous) / 2
        }
    };

    if candidate < min || candidate > max {
        return Err(PositionError::NeedsReindex);
    }
    if let (Some(previous), Some(next)) = (previous, next) {
        if candidate <= previous as i128 || candidate >= next as i128 {
            return Err(PositionError::NeedsReindex);
        }
    }

    i64::try_from(candidate).map_err(|_| PositionError::NeedsReindex)
}

/// 0 を中心に共通間隔で再採番したときの、指定位置の順位を返す。
pub fn reindexed_order_at(index: usize, count: usize) -> Result<i64, PositionError> {
    if index >= count {
        return Err(PositionError::InvalidOrder);
    }

    let index = index as i128;
    let count = count as i128;
    let centered_index = (2 * index) - count + 1;
    let candidate = centered_index * ORDER_GAP / 2;
    i64::try_from(candidate).map_err(|_| PositionError::OutOfRange)
}

#[cfg(test)]
mod tests {
    use super::{order_between, reindexed_order_at, PositionError, ORDER_GAP};

    #[test]
    fn order_between_handles_empty_ends_and_middle() {
        assert_eq!(order_between(None, None), Ok(0));
        assert_eq!(order_between(None, Some(ORDER_GAP as i64)), Ok(0));
        assert_eq!(order_between(Some(0), None), Ok(ORDER_GAP as i64));
        assert_eq!(
            order_between(Some(0), Some((ORDER_GAP * 2) as i64)),
            Ok(ORDER_GAP as i64)
        );
    }

    #[test]
    fn order_between_requests_reindex_when_no_safe_integer_gap_exists() {
        assert_eq!(
            order_between(Some(4), Some(5)),
            Err(PositionError::NeedsReindex)
        );
        assert_eq!(
            order_between(Some(7), Some(7)),
            Err(PositionError::NeedsReindex)
        );
        assert_eq!(
            order_between(Some(8), Some(7)),
            Err(PositionError::InvalidOrder)
        );
    }

    #[test]
    fn order_between_checks_i64_edges_without_overflow() {
        assert_eq!(
            order_between(None, Some(i64::MIN)),
            Err(PositionError::NeedsReindex)
        );
        assert_eq!(
            order_between(Some(i64::MAX), None),
            Err(PositionError::NeedsReindex)
        );
        assert_eq!(order_between(Some(i64::MIN), Some(i64::MAX)), Ok(-1));
    }

    #[test]
    fn reindexing_is_centered_and_uses_the_same_gap() {
        assert_eq!(reindexed_order_at(0, 1), Ok(0));
        assert_eq!(reindexed_order_at(0, 3), Ok(-(ORDER_GAP as i64)));
        assert_eq!(reindexed_order_at(1, 3), Ok(0));
        assert_eq!(reindexed_order_at(2, 3), Ok(ORDER_GAP as i64));
        assert_eq!(reindexed_order_at(0, 2), Ok(-((ORDER_GAP / 2) as i64)));
        assert_eq!(reindexed_order_at(1, 2), Ok((ORDER_GAP / 2) as i64));
    }

    #[test]
    fn reindexing_supports_large_siblings_and_checks_bounds() {
        let count = 3_000;
        let first = reindexed_order_at(0, count).unwrap();
        let second = reindexed_order_at(1, count).unwrap();
        let last = reindexed_order_at(count - 1, count).unwrap();
        assert_eq!(second as i128 - first as i128, ORDER_GAP);
        assert_eq!(
            last as i128 - first as i128,
            ORDER_GAP * (count as i128 - 1)
        );
        assert_eq!(
            reindexed_order_at(usize::MAX, usize::MAX),
            Err(PositionError::InvalidOrder)
        );
        assert_eq!(
            reindexed_order_at(0, usize::MAX),
            Err(PositionError::OutOfRange)
        );
    }
}
