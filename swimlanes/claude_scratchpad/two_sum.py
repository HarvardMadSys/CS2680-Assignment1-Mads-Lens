def two_sum(nums: list[int], target: int) -> list[int]:
    seen_value_to_index: dict[int, int] = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen_value_to_index:
            return [seen_value_to_index[complement], index]
        seen_value_to_index[value] = index
