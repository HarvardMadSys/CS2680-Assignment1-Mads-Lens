from two_sum import two_sum


def test_basic_example():
    result = two_sum([2, 7, 11, 15], 9)
    assert sorted(result) == [0, 1]


def test_answer_at_end_of_array():
    result = two_sum([1, 2, 3, 4, 6], 10)
    assert sorted(result) == [3, 4]


def test_negative_numbers():
    result = two_sum([-3, 4, 3, 90], 0)
    assert sorted(result) == [0, 2]


def test_duplicates_not_the_answer():
    result = two_sum([5, 5, 3, 8], 11)
    assert sorted(result) == [2, 3]


def test_matching_numbers_are_duplicates_of_each_other():
    result = two_sum([3, 3], 6)
    assert sorted(result) == [0, 1]
